//! A plugin configuring the provider rows it owns (ADR 0319).
//!
//! A sign-in plugin learns its endpoint's credential, and sometimes the endpoint
//! itself, only after the user signs in, so the manifest cannot carry them. These
//! calls let the owning plugin hand both to the Host:
//!
//! - the API key goes to the Host secret store under the row's usual ref and is
//!   never readable back through any plugin path (write only);
//! - the base URL is accepted only when the declaration leaves `baseUrl` out, and
//!   is kept in the row's config so the next declaration refresh restores it.
//!
//! Electron main checks `provider.register` before it dispatches; here the row
//! must exist and be owned by the calling plugin, whatever the caller claims.

use super::*;
use serde_json::{json, Value};

/// Longest API key a plugin may store. Keys are signed into an HTTP header.
const MAX_PLUGIN_PROVIDER_KEY_CHARS: usize = 4096;
/// Longest base URL a plugin may set.
const MAX_PLUGIN_PROVIDER_URL_CHARS: usize = 2048;
/// Where a plugin-set base URL lives inside `providers.config_json`.
const PLUGIN_BASE_URL_KEY: &str = "pluginBaseUrl";

/// The base URL a plugin set on a row whose declaration omits `baseUrl`.
pub(crate) fn config_plugin_base_url(raw: Option<&str>) -> Option<String> {
    let value: Value = serde_json::from_str(raw?).ok()?;
    value
        .get(PLUGIN_BASE_URL_KEY)?
        .as_str()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
}

/// The row a declared id names, once it is known to exist and to be owned by
/// `plugin_id`. A user row or another plugin's row is refused.
fn owned_row(db: &Database, plugin_id: &str, declared_id: &str) -> Result<String> {
    let declared_id = declared_id.trim();
    let valid_id = declared_id
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && declared_id.len() <= 64
        && declared_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid_id {
        bail!("INVALID_PARAMS: provider id must be the id declared in contributes.providers");
    }
    let row_id = plugin_provider_row_id(plugin_id, declared_id);
    match provider_owner_plugin(db, &row_id)? {
        Some(owner) if owner == plugin_id => Ok(row_id),
        Some(_) => bail!("PERMISSION_DENIED: provider {row_id} is not owned by {plugin_id}"),
        None if provider_row_exists(db, &row_id)? => {
            bail!("PERMISSION_DENIED: provider {row_id} is not owned by {plugin_id}")
        }
        None => bail!("NOT_FOUND: {plugin_id} declares no provider {declared_id}"),
    }
}

/// Store (`Some`) or clear (`None`) the API key of a row the plugin owns.
///
/// Nothing is returned: a plugin can write its credential but never read it.
pub(crate) fn set_owned_provider_credential(
    db: &Database,
    secrets: &SecretStore,
    plugin_id: &str,
    declared_id: &str,
    api_key: Option<&str>,
) -> Result<()> {
    let row_id = owned_row(db, plugin_id, declared_id)?;
    let auth_kind: String = db.conn().query_row(
        "SELECT auth_kind FROM providers WHERE id = ?1",
        params![row_id],
        |row| row.get(0),
    )?;
    let key = match api_key {
        Some(raw) => {
            if auth_kind != "api_key" {
                bail!("INVALID_PARAMS: provider {row_id} does not take an API key");
            }
            let key = raw.trim();
            if key.is_empty() {
                bail!("INVALID_PARAMS: the API key is empty");
            }
            if key.chars().count() > MAX_PLUGIN_PROVIDER_KEY_CHARS {
                bail!("INVALID_PARAMS: the API key is longer than {MAX_PLUGIN_PROVIDER_KEY_CHARS} characters");
            }
            if key.chars().any(char::is_control) {
                bail!("INVALID_PARAMS: the API key contains a line break or control character");
            }
            Some(key)
        }
        None => None,
    };
    providers::set_provider_secret(db, secrets, &row_id, key)?;
    Ok(())
}

/// An absolute http(s) URL; plain http only for this computer.
fn checked_base_url(raw: &str) -> Result<String> {
    let url = raw.trim();
    if url.is_empty() || url.chars().count() > MAX_PLUGIN_PROVIDER_URL_CHARS {
        bail!(
            "INVALID_PARAMS: the base URL must be 1 to {MAX_PLUGIN_PROVIDER_URL_CHARS} characters"
        );
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| anyhow::anyhow!("INVALID_PARAMS: the base URL is not an absolute URL"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        bail!("INVALID_PARAMS: the base URL must not embed credentials");
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let local = host == "localhost" || host == "127.0.0.1" || host.ends_with(".localhost");
    match parsed.scheme() {
        "https" if !host.is_empty() => {}
        "http" if local => {}
        "http" => bail!("INVALID_PARAMS: plain http is allowed only for localhost"),
        _ => bail!("INVALID_PARAMS: the base URL must use https"),
    }
    Ok(url.to_string())
}

/// Point a row the plugin owns at `base_url`, when its declaration leaves the
/// endpoint open. `declared` is the plugin's current declaration.
pub(crate) fn set_owned_provider_base_url(
    db: &Database,
    plugin_id: &str,
    declared: &[DeclaredPluginProvider],
    declared_id: &str,
    base_url: &str,
) -> Result<()> {
    let row_id = owned_row(db, plugin_id, declared_id)?;
    let Some(declaration) = declared
        .iter()
        .find(|provider| plugin_provider_row_id(plugin_id, &provider.id) == row_id)
    else {
        bail!(
            "NOT_FOUND: {plugin_id} declares no provider {}",
            declared_id.trim()
        );
    };
    if declaration.base_url.is_some() {
        bail!("PERMISSION_DENIED: provider {row_id} declares its baseUrl in the manifest");
    }
    let url = checked_base_url(base_url)?;
    let (raw_config, current): (String, Option<String>) = db.conn().query_row(
        "SELECT config_json, base_url FROM providers WHERE id = ?1",
        params![row_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    // An unreadable config is refused rather than replaced: replacing it would
    // drop the model bindings and headers stored beside the endpoint.
    let mut config: Value = serde_json::from_str(&raw_config)
        .map_err(|_| anyhow::anyhow!("provider {row_id} has an unreadable config_json"))?;
    let Some(object) = config.as_object_mut() else {
        bail!("provider config_json must be a JSON object");
    };
    object.insert(PLUGIN_BASE_URL_KEY.into(), json!(url));
    db.conn()
        .prepare_cached(
            "UPDATE providers SET base_url = ?2, config_json = ?3, updated_at = ?4 WHERE id = ?1",
        )?
        .execute(params![row_id, url, config.to_string(), now_ms()])?;
    // The discovered answer belongs to the endpoint that produced it.
    if current.as_deref().unwrap_or("").trim() != url {
        let declared_models: Vec<String> = declaration
            .models
            .iter()
            .map(|model| model.id.clone())
            .collect();
        providers::forget_missing_discovered_models(db, &row_id, &declared_models)?;
    }
    Ok(())
}

//! ADR 0319: a plugin configuring the provider rows it owns (key and endpoint).

use super::tests::{manifest, manifest_with_auth_kind, test_context};
use super::*;

/// The demo declaration without `baseUrl`, so the plugin supplies the endpoint.
fn manifest_without_base_url() -> PluginManifest {
    let mut value = serde_json::to_value(manifest()).unwrap();
    value["contributes"]["providers"][0]
        .as_object_mut()
        .unwrap()
        .remove("baseUrl");
    serde_json::from_value(value).unwrap()
}

#[test]
fn a_plugin_stores_and_clears_the_key_of_its_own_row() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let id = "plugin:demo.provider:demo";

    set_owned_provider_credential(
        &db,
        &secrets,
        "demo.provider",
        "demo",
        Some("  sk-signed-in  "),
    )
    .unwrap();
    let row = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert!(row.has_secret);
    // Stored under the usual provider ref, so the runtime resolves it as for
    // any other row; the public row only says a key exists.
    assert_eq!(
        providers::get_secret_for_provider(&db, &secrets, id)
            .unwrap()
            .as_deref(),
        Some("sk-signed-in")
    );
    assert!(!serde_json::to_string(&row)
        .unwrap()
        .contains("sk-signed-in"));

    // The next declaration refresh keeps it.
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    assert!(
        providers::get_provider(&db, &secrets, id)
            .unwrap()
            .unwrap()
            .has_secret
    );

    // Signing out clears it.
    set_owned_provider_credential(&db, &secrets, "demo.provider", "demo", None).unwrap();
    assert!(
        !providers::get_provider(&db, &secrets, id)
            .unwrap()
            .unwrap()
            .has_secret
    );
    assert!(providers::get_secret_for_provider(&db, &secrets, id)
        .unwrap()
        .is_none());
}

#[test]
fn a_plugin_cannot_configure_a_row_it_does_not_own() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest_without_base_url());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let id = "plugin:demo.provider:demo";
    let refused = |plugin: &str, declared_id: &str| {
        let key = set_owned_provider_credential(&db, &secrets, plugin, declared_id, Some("sk-x"))
            .expect_err("the key must be refused")
            .to_string();
        let url = set_owned_provider_base_url(
            &db,
            plugin,
            &declared,
            declared_id,
            "https://ai.example.com/v1",
        )
        .expect_err("the endpoint must be refused")
        .to_string();
        (key, url)
    };

    // A provider the plugin never declared.
    let (key, url) = refused("demo.provider", "missing");
    assert!(key.starts_with("NOT_FOUND:"), "{key}");
    assert!(url.starts_with("NOT_FOUND:"), "{url}");
    // An id that is not a declared id at all.
    let (key, _) = refused("demo.provider", "../demo");
    assert!(key.starts_with("INVALID_PARAMS:"), "{key}");

    // Another plugin's row.
    db.conn()
        .execute(
            "UPDATE providers SET owner_plugin_id = 'other.plugin' WHERE id = ?1",
            params![id],
        )
        .unwrap();
    let (key, url) = refused("demo.provider", "demo");
    assert!(key.starts_with("PERMISSION_DENIED:"), "{key}");
    assert!(url.starts_with("PERMISSION_DENIED:"), "{url}");

    // A user row sitting on the same id.
    db.conn()
        .execute(
            "UPDATE providers SET owner_plugin_id = NULL WHERE id = ?1",
            params![id],
        )
        .unwrap();
    let (key, url) = refused("demo.provider", "demo");
    assert!(key.starts_with("PERMISSION_DENIED:"), "{key}");
    assert!(url.starts_with("PERMISSION_DENIED:"), "{url}");

    // Nothing was written by any refused call.
    let row = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert!(!row.has_secret);
    assert!(row.base_url.is_none());
}

#[test]
fn the_key_is_checked_before_it_is_stored() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let too_long = "k".repeat(4097);
    for bad in ["", "   ", "sk-a\nsk-b", "sk\u{0}x", too_long.as_str()] {
        let error =
            set_owned_provider_credential(&db, &secrets, "demo.provider", "demo", Some(bad))
                .expect_err("a bad key must be refused")
                .to_string();
        assert!(error.starts_with("INVALID_PARAMS:"), "{error}");
    }
    assert!(
        !providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
            .unwrap()
            .unwrap()
            .has_secret
    );

    // A row whose declaration asks for no key takes none.
    let (_dir2, db2, secrets2) = test_context();
    let keyless = declared_providers(&manifest_with_auth_kind("none"));
    sync_plugin_providers(&db2, &secrets2, "demo.provider", &keyless, true).unwrap();
    let error =
        set_owned_provider_credential(&db2, &secrets2, "demo.provider", "demo", Some("sk-x"))
            .expect_err("a keyless row must refuse a key")
            .to_string();
    assert!(error.contains("does not take an API key"), "{error}");
}

#[test]
fn a_plugin_sets_the_endpoint_its_declaration_leaves_open_and_a_reload_keeps_it() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest_without_base_url());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let id = "plugin:demo.provider:demo";
    assert!(providers::get_provider(&db, &secrets, id)
        .unwrap()
        .unwrap()
        .base_url
        .is_none());

    set_owned_provider_base_url(
        &db,
        "demo.provider",
        &declared,
        "demo",
        " https://ai.example.com/v1 ",
    )
    .unwrap();
    let base_url = |db: &Database| {
        providers::get_provider(db, &secrets, id)
            .unwrap()
            .unwrap()
            .base_url
    };
    assert_eq!(base_url(&db).as_deref(), Some("https://ai.example.com/v1"));
    // The declaration refresh on every load restores it.
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    assert_eq!(base_url(&db).as_deref(), Some("https://ai.example.com/v1"));

    // Plain http only for this computer.
    for local in [
        "http://127.0.0.1:4000/v1",
        "http://localhost:4000/v1",
        "http://gateway.tbo.localhost/v1",
    ] {
        set_owned_provider_base_url(&db, "demo.provider", &declared, "demo", local).unwrap();
        assert_eq!(base_url(&db).as_deref(), Some(local));
    }
    for bad in [
        "http://ai.example.com/v1",
        "ftp://ai.example.com/v1",
        "ai.example.com/v1",
        "https://user:secret@ai.example.com/v1",
        "",
    ] {
        let error = set_owned_provider_base_url(&db, "demo.provider", &declared, "demo", bad)
            .expect_err("a bad endpoint must be refused")
            .to_string();
        assert!(error.starts_with("INVALID_PARAMS:"), "{bad}: {error}");
    }
    assert_eq!(
        base_url(&db).as_deref(),
        Some("http://gateway.tbo.localhost/v1")
    );
}

#[test]
fn a_declared_endpoint_cannot_be_moved_by_the_plugin() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let error = set_owned_provider_base_url(
        &db,
        "demo.provider",
        &declared,
        "demo",
        "https://elsewhere.example.com/v1",
    )
    .expect_err("a declared endpoint must be refused")
    .to_string();
    assert!(error.contains("declares its baseUrl"), "{error}");
    assert_eq!(
        providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
            .unwrap()
            .unwrap()
            .base_url
            .as_deref(),
        Some("https://api.example.com/v1")
    );
}

import type { PluginSummary } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { IconUser } from "./icons";
import { TooltipButton } from "./ui";

// TBO testing fixes 9: signing in to and out of TBO Support is always in reach.
// The TBO Support plugin owns the panel (Sign in with Microsoft; who is signed
// in and Sign out; projects and tasks; report a problem), and its "TBO Support:
// Sign in" command opens it. A plugin cannot add a sidebar button, so the app
// shows this one in the sidebar's footer while that plugin is on.
export const TBO_SUPPORT_PLUGIN_ID = "tbo.support";
export const TBO_SUPPORT_PANEL_COMMAND = "tbo-support.sign-in";

export function tboSupportAvailable(plugins: readonly PluginSummary[] | undefined): boolean {
  return Boolean(
    plugins?.some(
      (plugin) => plugin.id === TBO_SUPPORT_PLUGIN_ID && plugin.enabled && plugin.status === "ready",
    ),
  );
}

/** Opens the TBO Support panel through the plugin's own command; a refusal becomes the toast's text. */
export async function openTboSupportPanel(onError: (reason: string) => void): Promise<void> {
  try {
    await api.executeCommand(TBO_SUPPORT_PANEL_COMMAND);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}

export function TboSupportButton({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const { t } = useTranslation();
  const available = useAppStore((s) => tboSupportAvailable(s.plugins));
  const showToast = useAppStore((s) => s.showToast);
  if (!available) return null;
  return (
    <TboSupportFooterAction
      label={t("nav.tboSupport")}
      onOpen={() => {
        onBeforeOpen?.();
        void openTboSupportPanel((reason) =>
          showToast(t("nav.tboSupportFailed", { reason }), { variant: "error" }),
        );
      }}
    />
  );
}

/** The footer action itself, drawn like Settings, Plugins and Scheduled beside it. */
export function TboSupportFooterAction({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <TooltipButton
      type="button"
      className="footer-action"
      data-nav="tbo-support"
      tooltip={label}
      ariaLabel={label}
      onClick={onOpen}
    >
      <IconUser size={14} aria-hidden />
    </TooltipButton>
  );
}

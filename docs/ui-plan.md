# UI Plan

PulseDeck uses the real upstream SoybeanAdmin template as its frontend foundation:

- Keep SoybeanAdmin's Vue 3, TypeScript, Naive UI, UnoCSS, Pinia, router, layout, theme drawer, tabs, and request conventions.
- Replace the default demo/home pages with sing-box operations modules: Dashboard, Nodes, sing-box Config, Subscriptions, Alerts, Commands, Settings.
- Use Soybean route/menu metadata as the source of sidebar structure.
- Keep dense dashboard cards for online nodes, warnings, traffic, and command backlog.
- Use node tables plus cards/drawers for install command, probe metrics, addresses, diagnostics, and sing-box render/apply actions.
- Use subscription URL cards with copy/open/enable/delete actions.

The panel should fetch only current-view data. Dashboard data should stay small and avoid loading subscription previews, audit logs, or advanced modules by default.

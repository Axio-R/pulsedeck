# UI Plan

PulseDeck uses a SoybeanAdmin-inspired operations layout:

- Fixed sidebar with major domains: Dashboard, Nodes, Subscriptions, Alerts, Commands, Settings.
- Compact topbar for health, refresh, and account actions.
- Dense dashboard cards for online nodes, warnings, traffic, and command backlog.
- Node table plus detail drawer/cards for install command, probe metrics, addresses, and diagnostics.
- Subscription URL cards with copy/open/enable/delete actions.
- Settings pages are grouped by operational purpose instead of broad product marketing sections.

The panel should fetch only current-view data. Dashboard data should stay small and avoid loading subscription previews, audit logs, or advanced modules by default.

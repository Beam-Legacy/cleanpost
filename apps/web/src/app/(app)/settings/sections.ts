/** The settings sections, their view IDs, and whether each is built yet (docs/16 for the rest). */
export const SETTINGS_SECTIONS = [
  { key: 'users', label: 'Users and roles', view: 'S-01', built: true },
  { key: 'automation', label: 'Automation', view: 'S-04', built: true },
  { key: 'rules', label: 'Rules', view: 'S-05', built: true },
  { key: 'mappings', label: 'Adjustment mappings', view: 'S-08', built: true },
  { key: 'notifications', label: 'Notifications', view: 'S-09', built: true },
  { key: 'branding', label: 'Branding', view: 'S-10', built: true },
  { key: 'usage', label: 'Usage and billing', view: 'S-11', built: true },
  { key: 'security', label: 'Security', view: 'S-12', built: true },
  { key: 'company', label: 'Company profile', view: 'S-14', built: true },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['key'];

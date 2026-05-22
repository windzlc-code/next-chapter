export function shouldForceSilentWorkflowShortcut(action: string): boolean {
  return action === "export_compliance_palette" || action === "export_storyboard_xlsx";
}

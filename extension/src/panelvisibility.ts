export function createPanelVisibility<Panel>() {
  const revisions = new Map<Panel, number>();
  return {
    current(panel: Panel, visible: boolean) {
      const revision = (revisions.get(panel) ?? 0) + 1;
      revisions.set(panel, revision);
      return { type: 'visibility' as const, visible, revision };
    },
    release(panel: Panel) {
      revisions.delete(panel);
    },
    clear() {
      revisions.clear();
    },
  };
}

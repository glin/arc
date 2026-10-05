export interface PageStyleOwner {
  setIconFonts(rules: readonly string[]): void;
}

export function createPageStyleOwner(document: Document): PageStyleOwner {
  let style = document.getElementById('icon-fonts');
  return {
    setIconFonts(rules) {
      const text = rules.join('');
      if (!style) {
        style = document.createElement('style');
        style.id = 'icon-fonts';
        document.head.append(style);
      }
      if (style.textContent !== text) {
        style.textContent = text;
      }
    },
  };
}

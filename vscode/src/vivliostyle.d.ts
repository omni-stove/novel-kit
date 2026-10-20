/** Vivliostyle Viewer がページに置く window.coreViewer のうち、pdf-renderer.mjs が page.evaluate の中で使うもの */
interface Window {
  coreViewer: {
    readyState: string;
    getMetadata(): unknown;
    getTOC(): unknown;
    showTOC(show: boolean): void;
    addListener(type: string, listener: (payload: { a: string }) => void): void;
    removeListener(type: string, listener: (payload: { a: string }) => void): void;
  };
}

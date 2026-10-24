export {};

declare global {
  interface Window {
    firefly: {
      minimize: () => void;
      setInteractive: (interactive: boolean) => Promise<void>;
      moveTo: (x: number, y: number) => void;
      setDragging: (isDragging: boolean) => void;
      getCursorPosition: () => Promise<{ x: number; y: number } | null>;
      onPetZoom: (callback: (zoom: number) => void) => () => void;
      onPetVisibilityChanged: (callback: (visible: boolean) => void) => () => void;
    };
  }
}

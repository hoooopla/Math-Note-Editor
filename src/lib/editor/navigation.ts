import { keymap } from "@codemirror/view";

export const blockNavigation = (onUp: () => void, onDown: () => void) => keymap.of([
    {
        key: "ArrowUp",
        run: (view) => {
            const selection = view.state.selection.main;
            if (!selection.empty) return false;
            
            const line = view.state.doc.lineAt(selection.from);
            if (line.number === 1) {
                onUp();
                return true;
            }
            return false;
        }
    },
    {
        key: "ArrowDown",
        run: (view) => {
            const selection = view.state.selection.main;
            if (!selection.empty) return false;

            const line = view.state.doc.lineAt(selection.from);
            if (line.number === view.state.doc.lines) {
                onDown();
                return true;
            }
            return false;
        }
    }
]);

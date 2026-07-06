import { EditorState, EditorSelection } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

const customDollarPairing = keymap.of([{
    key: "$",
    run: (view) => {
        const state = view.state;
        const changes = state.changeByRange(range => {
            if (!range.empty) {
                return {
                    changes: [
                        { insert: "$", from: range.from },
                        { insert: "$", from: range.to }
                    ],
                    range: EditorSelection.range(range.anchor + 1, range.head + 1)
                };
            }
            
            const pos = range.head;
            const nextChar = state.doc.sliceString(pos, pos + 1);
            
            if (nextChar === "$") {
                return {
                    range: EditorSelection.cursor(pos + 1)
                };
            }
            
            return {
                changes: { insert: "$$", from: pos },
                range: EditorSelection.cursor(pos + 1)
            };
        });
        
        if (changes.changes.empty) {
            view.dispatch(changes);
            return true;
        }
        
        view.dispatch(state.update(changes, {
            scrollIntoView: true,
            userEvent: "input.type"
        }));
        return true;
    }
}]);

const state = EditorState.create({
  doc: "$\n\n",
  selection: { anchor: 3 },
  extensions: [
    markdown(),
    closeBrackets(),
    customDollarPairing,
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", "'", '"'] } }]),
  ]
});

// Since we can't easily trigger the keymap without an EditorView in Node,
// let's just create an EditorView with a mock document (jsdom).

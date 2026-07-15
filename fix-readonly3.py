import re

with open('src/components/CodeMirrorEditor.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    'export function CodeMirrorEditor({ content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels, onEsc, onImagePaste, isReadOnly = false }: CodeMirrorEditorProps) {',
    'export function CodeMirrorEditor({ content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels, onEsc, onImagePaste }: CodeMirrorEditorProps) {'
)

content = content.replace(
    'export function CodeMirrorEditor({ content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels, onEsc, onImagePaste }: CodeMirrorEditorProps) {',
    'export function CodeMirrorEditor({ content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels, onEsc, onImagePaste, isReadOnly = false }: CodeMirrorEditorProps) {'
)

content = content.replace(
    'const macrosCompartmentRef = useRef(new Compartment());',
    'const macrosCompartmentRef = useRef(new Compartment());\n    const editableCompartmentRef = useRef(new Compartment());'
)

content = content.replace(
    'macrosCompartmentRef.current.of(livePreviewMacros.of(macros)),',
    'macrosCompartmentRef.current.of(livePreviewMacros.of(macros)),\n                editableCompartmentRef.current.of(EditorView.editable.of(!isReadOnly)),'
)

content = content.replace(
    'effects.push(macrosCompartmentRef.current.reconfigure(livePreviewMacros.of(macros)));',
    'effects.push(macrosCompartmentRef.current.reconfigure(livePreviewMacros.of(macros)));\n            effects.push(editableCompartmentRef.current.reconfigure(EditorView.editable.of(!isReadOnly)));'
)

with open('src/components/CodeMirrorEditor.tsx', 'w') as f:
    f.write(content)

import re

with open('src/components/CodeMirrorEditor.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    'export function CodeMirrorEditor({ content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels, onEsc, onImagePaste }: CodeMirrorEditorProps) {',
    'export function CodeMirrorEditor({ content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels, onEsc, onImagePaste, isReadOnly = false }: CodeMirrorEditorProps) {'
)

# find the state creation
extensions_block = """
            extensions: [
"""

new_extensions_block = """
            extensions: [
                EditorView.editable.of(!isReadOnly),
"""

compartment_decl = """
const parentLabelCompartment = new Compartment();
const visitedLabelsCompartment = new Compartment();
"""

new_compartment_decl = """
const parentLabelCompartment = new Compartment();
const visitedLabelsCompartment = new Compartment();
const editableCompartment = new Compartment();
"""

content = content.replace(compartment_decl, new_compartment_decl)

ext_setup = """
                parentLabelCompartment.of(parentLabelFacet.of(parentLabel || "")),
                visitedLabelsCompartment.of(visitedLabelsFacet.of(visitedLabels || [])),
"""

new_ext_setup = """
                editableCompartment.of(EditorView.editable.of(!isReadOnly)),
                parentLabelCompartment.of(parentLabelFacet.of(parentLabel || "")),
                visitedLabelsCompartment.of(visitedLabelsFacet.of(visitedLabels || [])),
"""
content = content.replace(ext_setup, new_ext_setup)


dispatch_block = """
        viewRef.current.dispatch({
            effects: [
                parentLabelCompartment.reconfigure(parentLabelFacet.of(parentLabel || "")),
                visitedLabelsCompartment.reconfigure(visitedLabelsFacet.of(visitedLabels || []))
            ]
        });
"""

new_dispatch_block = """
        viewRef.current.dispatch({
            effects: [
                parentLabelCompartment.reconfigure(parentLabelFacet.of(parentLabel || "")),
                visitedLabelsCompartment.reconfigure(visitedLabelsFacet.of(visitedLabels || [])),
                editableCompartment.reconfigure(EditorView.editable.of(!isReadOnly))
            ]
        });
"""

content = content.replace(dispatch_block, new_dispatch_block)

with open('src/components/CodeMirrorEditor.tsx', 'w') as f:
    f.write(content)

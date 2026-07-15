import re

with open('src/components/CodeMirrorEditor.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    'export interface CodeMirrorEditorProps {',
    'export interface CodeMirrorEditorProps {\n    isReadOnly?: boolean;'
)

content = content.replace(
    'export const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = React.memo(({ content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels = [], onImagePaste }) => {',
    'export const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = React.memo(({ content, onBlur, onChange, onUp, onDown, isFocused, macros, focusDirection, onFocus, parentLabel, visitedLabels = [], onImagePaste, isReadOnly = false }) => {'
)

# find the state creation
extensions_block = """
            extensions: [
"""

new_extensions_block = """
            extensions: [
                EditorView.editable.of(!isReadOnly),
"""

content = content.replace(extensions_block, new_extensions_block)

# We also need to update the extension dynamically if it changes
useEffect_block = """
    useEffect(() => {
        if (!viewRef.current) return;
        
        // Ensure parentLabel is up-to-date in extensions
"""

new_useEffect_block = """
    useEffect(() => {
        if (!viewRef.current) return;
        viewRef.current.dispatch({
            effects: StateEffect.reconfigure.of([
                EditorView.editable.of(!isReadOnly),
                ...baseExtensions
            ])
        });
    }, [isReadOnly]);

    useEffect(() => {
        if (!viewRef.current) return;
        
        // Ensure parentLabel is up-to-date in extensions
"""

# Actually, reconfiguring extensions like that would blow away all other extensions and might break plugins. 
# Better to use a Compartment for editable.

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
                visitedLabelsCompartment.of(visitedLabelsFacet.of(visitedLabels)),
"""

new_ext_setup = """
                editableCompartment.of(EditorView.editable.of(!isReadOnly)),
                parentLabelCompartment.of(parentLabelFacet.of(parentLabel || "")),
                visitedLabelsCompartment.of(visitedLabelsFacet.of(visitedLabels)),
"""
content = content.replace(ext_setup, new_ext_setup)

# We also need to get rid of the first replacement if we used compartment
content = content.replace(new_extensions_block, extensions_block)

dispatch_block = """
        viewRef.current.dispatch({
            effects: [
                parentLabelCompartment.reconfigure(parentLabelFacet.of(parentLabel || "")),
                visitedLabelsCompartment.reconfigure(visitedLabelsFacet.of(visitedLabels))
            ]
        });
"""

new_dispatch_block = """
        viewRef.current.dispatch({
            effects: [
                parentLabelCompartment.reconfigure(parentLabelFacet.of(parentLabel || "")),
                visitedLabelsCompartment.reconfigure(visitedLabelsFacet.of(visitedLabels)),
                editableCompartment.reconfigure(EditorView.editable.of(!isReadOnly))
            ]
        });
"""

content = content.replace(dispatch_block, new_dispatch_block)

with open('src/components/CodeMirrorEditor.tsx', 'w') as f:
    f.write(content)

with open('src/components/Block.tsx', 'r') as f:
    content2 = f.read()

if 'const backendMode = useStore(state => state.backendMode);' not in content2:
    content2 = content2.replace(
        'export const Block: React.FC<{ block: BlockData; activePath?: string[]; onUp: () => void; onDown: () => void }> = ({ block, activePath = [], onUp, onDown }) => {',
        'export const Block: React.FC<{ block: BlockData; activePath?: string[]; onUp: () => void; onDown: () => void }> = ({ block, activePath = [], onUp, onDown }) => {\n    const backendMode = useStore(state => state.backendMode);'
    )
    
content2 = content2.replace(
    'isFocused={isFocused && !isEditingMeta}',
    'isFocused={isFocused && !isEditingMeta}\n                    isReadOnly={backendMode === "viewer"}'
)

with open('src/components/Block.tsx', 'w') as f:
    f.write(content2)


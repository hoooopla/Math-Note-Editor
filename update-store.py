import re

with open('src/store/index.ts', 'r') as f:
    content = f.read()

# Replace initial state
content = content.replace(
    'export const useStore = create<AppState>((set, get) => ({',
    '''const savedTabsStr = localStorage.getItem("openTabs");
const savedTabs = savedTabsStr ? JSON.parse(savedTabsStr) : [];
const savedActiveTab = localStorage.getItem("activeTab");

export const useStore = create<AppState>((set, get) => ({'''
)

content = content.replace('openTabs: [],', 'openTabs: savedTabs,')
content = content.replace('activeTab: null,\n  backendMode: "none",', 'activeTab: savedActiveTab,\n  backendMode: "none",')

# Add subscription at the end
content += '''
let lastTabs = savedTabs;
let lastActiveTab = savedActiveTab;
useStore.subscribe((state) => {
    if (state.openTabs !== lastTabs) {
        localStorage.setItem("openTabs", JSON.stringify(state.openTabs));
        lastTabs = state.openTabs;
    }
    if (state.activeTab !== lastActiveTab) {
        if (state.activeTab) {
            localStorage.setItem("activeTab", state.activeTab);
        } else {
            localStorage.removeItem("activeTab");
        }
        lastActiveTab = state.activeTab;
    }
});
'''

with open('src/store/index.ts', 'w') as f:
    f.write(content)

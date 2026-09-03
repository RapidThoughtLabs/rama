import { ThemeProvider, ToastProvider, mergeThemes } from "@rama/ui";
import { AppShell } from "./app/AppShell";
import { ProjectsProvider } from "./app/data/ProjectsProvider";
import { ProvidersProvider } from "./app/data/ProvidersProvider";
import { SessionProvider } from "./app/data/SessionProvider";
import { ThemesProvider, useThemesData } from "./app/data/ThemesProvider";
import { WindowTabsProvider } from "./app/data/WindowTabsProvider";

// SETTINGS_PLAN.md Phase S1 — ThemeProvider (packages/ui) needs the merged builtin+user theme
// list as a prop (it doesn't talk to the engine itself), so ThemesProvider has to sit outside it
// and this thin layer bridges the two.
function ThemedApp() {
  const { userThemes } = useThemesData();
  return (
    <ThemeProvider themes={mergeThemes(userThemes)}>
      <ToastProvider>
        <ProvidersProvider>
          <ProjectsProvider>
            <WindowTabsProvider>
              <SessionProvider>
                <AppShell />
              </SessionProvider>
            </WindowTabsProvider>
          </ProjectsProvider>
        </ProvidersProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

function App() {
  return (
    <ThemesProvider>
      <ThemedApp />
    </ThemesProvider>
  );
}

export default App;

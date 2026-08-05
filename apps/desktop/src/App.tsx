import { ThemeProvider, ToastProvider } from "@rama/ui";
import { AppShell } from "./app/AppShell";
import { ProjectsProvider } from "./app/data/ProjectsProvider";
import { ProvidersProvider } from "./app/data/ProvidersProvider";
import { SessionProvider } from "./app/data/SessionProvider";
import { WindowTabsProvider } from "./app/data/WindowTabsProvider";

function App() {
  return (
    <ThemeProvider>
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

export default App;

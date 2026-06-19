import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/Layout";
import OverviewPage  from "@/pages/OverviewPage";
import TracesPage    from "@/pages/TracesPage";
import AgentsPage    from "@/pages/AgentsPage";
import MetricsPage   from "@/pages/MetricsPage";
import FailuresPage  from "@/pages/FailuresPage";
import SettingsPage  from "@/pages/SettingsPage";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/"         component={OverviewPage}  />
        <Route path="/traces"   component={TracesPage}    />
        <Route path="/agents"   component={AgentsPage}    />
        <Route path="/metrics"  component={MetricsPage}   />
        <Route path="/failures" component={FailuresPage}  />
        <Route path="/settings" component={SettingsPage}  />
        <Route>
          <div className="flex flex-col items-center justify-center h-full py-20">
            <div className="text-5xl font-bold text-foreground/10 mb-4">404</div>
            <div className="text-sm text-muted-foreground">Page not found</div>
          </div>
        </Route>
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

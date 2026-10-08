import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TasksPage from "../../src/pages/tasks";
import { useCanvasStore } from "../../src/stores/canvas/use-canvas-store";

// An empty loaded-canvas set proves the page discovers records independently of nodes.
useCanvasStore.setState({ projects: [] });
createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={new QueryClient()}><ConfigProvider><App><MemoryRouter><TasksPage /></MemoryRouter></App></ConfigProvider></QueryClientProvider>,
);

import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation, useParams, useSearchParams } from "react-router";

import { FullScreenLoader, WorkspaceRouteLoader } from "@/components/ui/aceternity/full-screen-loader";
import { loadAssetsPage, loadCanvasPage, loadCanvasProjectPage, loadCreatePage, loadHomePage, loadProjectDetailPage, loadProjectsPage, loadTasksPage } from "@/lib/workspace-route-modules";
import { CanvasRefreshShell } from "@/pages/canvas/canvas-refresh-shell";
import RouteErrorPage from "@/pages/route-error";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";

const AssetsPage = lazy(loadAssetsPage);
const HomePage = lazy(loadHomePage);
const CanvasPage = lazy(loadCanvasPage);
const CanvasProjectPage = lazy(loadCanvasProjectPage);
const CreatePage = lazy(loadCreatePage);
const TasksPage = lazy(loadTasksPage);
const NotFound = lazy(() => import("@/pages/not-found"));
const PluginsPage = lazy(() => import("@/pages/plugins"));
const EagleLibraryPage = lazy(() => import("@/pages/plugins/eagle"));
const ProjectDetailPage = lazy(loadProjectDetailPage);
const ProjectsPage = lazy(loadProjectsPage);
const SettingsPage = lazy(() => import("@/pages/settings"));
const LocalComfyPage = lazy(() => import("@/pages/local-comfy"));
const UserLayout = lazy(() => import("@/layouts/user-layout"));
const RequireFeature = lazy(() => import("@/components/workspace/require-feature").then((module) => ({ default: module.RequireFeature })));

function deferred(element: ReactNode) {
    return <Suspense fallback={<WorkspaceRouteLoader />}>{element}</Suspense>;
}

function fullScreenDeferred(element: ReactNode) {
    return <Suspense fallback={<FullScreenLoader label="正在打开创作空间" detail="准备当前页面" />}>{element}</Suspense>;
}

function WorkspaceLayout() {
    const { pathname } = useLocation();
    const isCanvasProjectRoute = pathname.startsWith("/canvas/");
    const fallback = isCanvasProjectRoute ? <CanvasRefreshShell /> : <FullScreenLoader label="正在打开创作空间" detail="准备当前页面" />;
    return <Suspense fallback={fallback}><UserLayout><Outlet /></UserLayout></Suspense>;
}

const nativeProjectViews = new Set(["overview", "chapters", "workflow", "canvases", "editor", "assets", "settings"]);

function ProjectLibraryRoute() {
    const [searchParams] = useSearchParams();
    return deferred(searchParams.get("view") === "production" ? <ProjectsPage /> : <CanvasPage />);
}

function LocalAwareProjectRoute() {
    const { projectId, view, chapterId, unitId, stage } = useParams();
    const localMode = isLocalWorkspaceMode();
    // Explicit project views use the native project API; a bare local project
    // route keeps its existing canvas alias.
    const nativeProjectView = Boolean((view && nativeProjectViews.has(view)) || chapterId || (unitId && stage));
    if (localMode && projectId && !nativeProjectView) return <Navigate to={`/canvas/${projectId}`} replace />;
    return deferred(<ProjectDetailPage />);
}

function LegacyProjectAliasRoute() {
    const { projectId, "*": rest } = useParams();
    return <Navigate to={`/projects/${projectId}${rest ? `/${rest}` : ""}`} replace />;
}

/**
 * DEV 专用实验室路由。
 *
 * lazy(() => import(...)) 写在函数体内，而不是模块顶层常量：
 * 生产构建时 import.meta.env.DEV 被替换为 false，本函数随之不可达，
 * 摇树会连同其中的动态 import 一起删除，实验室代码不进入生产依赖图。
 * 若把 lazy 提到模块顶层，动态 import 会被静态分析成真实 chunk 并打进 dist。
 */
function devRoutes() {
    const FolderPreviewLab = lazy(() => import("@/pages/dev/folder-preview-lab"));
    const DirectorReproLab = lazy(() => import("@/pages/dev/director-repro-lab"));
    const TestVoiceRecording = lazy(() => import("@/pages/test-voice-recording"));
    return [
        { path: "/dev/folders", element: fullScreenDeferred(<FolderPreviewLab />), errorElement: <RouteErrorPage /> },
        { path: "/dev/director-repro", element: fullScreenDeferred(<DirectorReproLab />), errorElement: <RouteErrorPage /> },
        { path: "/test-voice-recording", element: fullScreenDeferred(<TestVoiceRecording />), errorElement: <RouteErrorPage /> },
    ];
}

export const router = createBrowserRouter([
    ...(import.meta.env.DEV ? devRoutes() : []),
    {
        element: <WorkspaceLayout />,
        errorElement: <RouteErrorPage />,
        children: [
            { path: "/", element: deferred(<HomePage />) },
            { path: "/create", element: deferred(<CreatePage />) },
            {
                path: "/tasks",
                element: deferred(<TasksPage />),
            },
            { path: "/assets", element: deferred(<AssetsPage />) },
            { path: "/local-comfy", element: deferred(<LocalComfyPage />) },
            { path: "/skills", element: <Navigate to="/" replace /> },
            { path: "/skill", element: <Navigate to="/" replace /> },
            { path: "/skills/reference", element: <Navigate to="/" replace /> },
            {
                path: "/plugins",
                element: <RequireFeature feature="pluginCenterEnabled">{deferred(<PluginsPage />)}</RequireFeature>,
            },
            {
                path: "/plugins/eagle",
                element: <RequireFeature feature="pluginCenterEnabled">{deferred(<EagleLibraryPage />)}</RequireFeature>,
            },
            { path: "/settings", element: deferred(<SettingsPage />) },
            {
                path: "/projects",
                element: <ProjectLibraryRoute />,
            },
            // LibTV 使用单数 `/project` 作为项目库入口；直接渲染本地项目库，
            // 保留原始 URL，避免像素复刻时出现一次重定向造成的布局/加载闪烁。
            {
                path: "/project",
                element: <ProjectLibraryRoute />,
            },
            {
                path: "/projects/:projectId",
                element: <LocalAwareProjectRoute />,
            },
            { path: "/project/:projectId", element: <LegacyProjectAliasRoute /> },
            { path: "/project/:projectId/*", element: <LegacyProjectAliasRoute /> },
            {
                path: "/projects/:projectId/:view",
                element: <LocalAwareProjectRoute />,
            },
            {
                path: "/projects/:projectId/chapters/:chapterId",
                element: <LocalAwareProjectRoute />,
            },
            {
                path: "/projects/:projectId/workflow/:unitId/:stage",
                element: <LocalAwareProjectRoute />,
            },
            { path: "/canvas", element: deferred(<CanvasPage />) },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
        ],
    },
    { path: "*", element: fullScreenDeferred(<NotFound />) },
]);

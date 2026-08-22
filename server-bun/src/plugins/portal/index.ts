import Elysia from "elysia";
import { portalJobs } from "./route-jobs";
import { portalTextSeg } from "./route-textseg";
import { portalBubbles } from "./route-bubbles";
import { portalActions } from "./route-actions";
import { portalLibrary } from "./route-library";

export const portalPlugin = new Elysia({ prefix: "/api/portal" })
  .use(portalJobs)
  .use(portalTextSeg)
  .use(portalBubbles)
  .use(portalActions)
  .use(portalLibrary);

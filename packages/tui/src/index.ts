/**
 * @astral-mcp/tui — Ink terminal client for exploratory Projection testing
 * (PRD §13 "Manual TUI"). `projection-tui` runs the demo; the exports let a
 * host embed the App against any facade/author pair.
 */

export { App, type AppProps } from './app.js';
export {
  driveTask,
  type ApprovalPrompt,
  type DriveCallbacks,
  type DriveOptions,
  type DrivePhase,
  type DriveState,
  type SuspensionInfo,
} from './driver.js';

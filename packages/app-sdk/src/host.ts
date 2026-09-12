/**
 * `@bendyline/gezel-app-sdk/host` — run Gezel inside your application.
 *
 * The root entry connects to a Gezel the user already runs. This entry adds
 * the other half: when there is none, host one in your own process, against a
 * gezel home that belongs to your app. Both give you the same {@link Gezel}
 * afterwards, so application code does not branch on which happened.
 *
 * {@link Gezel} is the central object — the connection, the models, the
 * projects. Most work then happens in a {@link GezelProject}, because chats
 * and app tools are both project-scoped.
 *
 * ```ts
 * import { connectOrHost } from '@bendyline/gezel-app-sdk/host';
 *
 * const gezel = await connectOrHost({
 *   appId: 'qualla',
 *   appName: 'Qualla',
 *   // Hosting is opt-in; without it, a missing Gezel is an error.
 *   host: { nodePath: bundledNodePath },
 * });
 *
 * await gezel.ensureModel({ model: 'gemma4-e2b-q4', bundle: shippedGezmodel });
 * const project = await gezel.ensureProject({ package: shippedGezapp, folder: travelFolder });
 *
 * await project.registerTools({
 *   tools: [
 *     {
 *       name: 'add_travel_points',
 *       description: 'Award travel points to the traveller.',
 *       inputSchema: {
 *         type: 'object',
 *         properties: { points: { type: 'number' }, reason: { type: 'string' } },
 *         required: ['points'],
 *       },
 *       handler: async ({ points, reason }) => awardPoints(Number(points), String(reason)),
 *     },
 *   ],
 * });
 *
 * const chat = await project.openChat({ role: 'travel-guide' });
 * for await (const event of chat.send('Where should I eat in Utrecht?')) {
 *   if (event.type === 'delta') process.stdout.write(event.content);
 * }
 * ```
 *
 * Requires `@bendyline/gezel-service` to be installed alongside this SDK (an
 * optional peer dependency) only when you actually host.
 */
export { Gezel, connectOrHost } from './gezel.js';
export { GezelProject, type GezelProjectFacts } from './project.js';
export { GezelChat } from './chat.js';
export { hostedGezelHome } from './host-home.js';
export { registerAppTools } from './app-tools.js';
export { GezelApp } from './client.js';
export { GezelSdkError } from './errors.js';
export type {
  ChatTurnEvent,
  ConnectOrHostInput,
  ConnectionMode,
  DaemonConnection,
  EnsureModelEngine,
  EnsureModelOptions,
  EnsureModelResult,
  EnsureModelSource,
  EnsureProgressEvent,
  EnsureProjectOptions,
  HostLogger,
  HostOptions,
  HostServiceModule,
  OpenChatOptions,
} from './host-types.js';
export type {
  AppToolCallContext,
  AppToolDefinition,
  AppToolHandlerResult,
  AppToolsRegistration,
  RegisterAppToolsInput,
} from './types.js';

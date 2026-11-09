import { registerAppTools } from './app-tools.js';
import { type GezelChat, openChat } from './chat.js';
import type { DaemonConnection, OpenChatOptions } from './host-types.js';
import type { AppToolsRegistration, RegisterAppToolsInput } from './types.js';

/** What an application knows about the project it is working in. */
export interface GezelProjectFacts {
  /** Gezel id by role template id, e.g. `{ 'travel-guide': 'mira' }`. */
  gezels: Record<string, string>;
  /** The gezel this project treats as its lead, when it names one. */
  leadGezelId?: string;
  /** Present when the project came from an AI App this application applied. */
  app?: {
    id: string;
    version: string;
    /** False when this exact package was already installed. */
    imported: boolean;
    modelsEnsured: string[];
  };
}

/**
 * One project, and everything an application does inside it.
 *
 * Chats and app tools are both project-scoped, which is why they live here
 * rather than on {@link import('./gezel.js').Gezel}: an application that has a
 * project does not have to carry its id back into every call.
 */
export class GezelProject {
  constructor(
    private readonly daemon: DaemonConnection,
    readonly id: string,
    readonly facts: GezelProjectFacts,
    /** Open tool registrations, shared with the `Gezel` that closes them. */
    private readonly registrations?: Set<AppToolsRegistration>,
  ) {}

  /** Gezel id by role template id. */
  get gezels(): Record<string, string> {
    return this.facts.gezels;
  }

  get leadGezelId(): string | undefined {
    return this.facts.leadGezelId;
  }

  /** The AI App this project was applied from, when there is one. */
  get app(): GezelProjectFacts['app'] {
    return this.facts.app;
  }

  /**
   * Open (or resume) a conversation with one of this project's gezels, by id
   * or by role; with neither, its lead.
   */
  openChat(opts: Omit<OpenChatOptions, 'projectId'> = {}): Promise<GezelChat> {
    return openChat({ client: this.daemon.client }, { ...opts, projectId: this.id });
  }

  /**
   * Offer tools this application runs itself to the gezels in this project.
   * See {@link registerAppTools}.
   */
  async registerTools(
    input: Omit<RegisterAppToolsInput, 'projectId'>,
  ): Promise<AppToolsRegistration> {
    const registration = await registerAppTools(this.daemon, { ...input, projectId: this.id });
    const open = this.registrations;
    if (!open) return registration;
    open.add(registration);
    return {
      relayId: registration.relayId,
      ready: registration.ready,
      update: (tools, opts) => registration.update(tools, opts),
      close: async () => {
        open.delete(registration);
        await registration.close();
      },
    };
  }
}

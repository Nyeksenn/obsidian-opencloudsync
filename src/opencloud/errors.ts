import { MaintenanceModeError } from '../types';

// Messages are shown verbatim in the engine's "❌ Sync failed: <message>" notice, so they say what to do.

/** No space has been chosen yet; nothing may be synced until one is. */
export class SpaceNotSelectedError extends Error {
  constructor() {
    super('No OpenCloud space selected. Open the plugin settings, press "Connect" and choose a space.');
    this.name = 'SpaceNotSelectedError';
  }
}

/** The Server URL was changed after the space was chosen; the space belongs to the old server. */
export class ServerChangedError extends Error {
  constructor() {
    super('The Server URL changed since the space was chosen. Press "Connect" in the plugin settings and choose a space on the new server.');
    this.name = 'ServerChangedError';
  }
}

/**
 * The chosen space is no longer listed for this user (deleted, disabled, or access removed). Raised by connect() so the
 * engine never receives an empty listing for it: an empty listing reads as "everything was deleted".
 */
export class SpaceNotFoundError extends Error {
  constructor(public readonly spaceName: string) {
    super(`The OpenCloud space "${spaceName}" is no longer available to this account. Choose a space again in the plugin settings.`);
    this.name = 'SpaceNotFoundError';
  }
}

/** The server rejected the username / app token. */
export class OpenCloudAuthError extends Error {
  constructor() {
    super('OpenCloud rejected the username or app token (HTTP 401). Check both in the plugin settings; app tokens can expire.');
    this.name = 'OpenCloudAuthError';
  }
}

/** Same type as upstream's maintenance error (so every existing `instanceof` keeps working), with OpenCloud wording. */
export class OpenCloudMaintenanceError extends MaintenanceModeError {
  constructor() {
    super();
    this.message = 'The OpenCloud server is in maintenance mode. Try again later.';
  }
}

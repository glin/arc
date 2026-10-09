// Tracks visited sessions for Back and Forward navigation.
// The trail is separate from transcript depth and prompt history.

export interface Trail {
  // Oldest first. The reader moves along it and never edits it in the middle.
  places: string[];
  // Current position, or -1 when the trail is empty.
  at: number;
}

// Maximum retained visited sessions.
export const PLACE_LIMIT = 50;

export function emptyTrail(): Trail {
  return { places: [], at: -1 };
}

// Returns the current session, or null outside the trail.
export function trailPlace(trail: Trail): string | null {
  return trail.at >= 0 && trail.at < trail.places.length ? trail.places[trail.at] : null;
}

export function canStepBack(trail: Trail): boolean {
  return trail.at > 0;
}

export function canStepForward(trail: Trail): boolean {
  return trail.at >= 0 && trail.at < trail.places.length - 1;
}

// Records a session visit and removes the forward entries after the current position.
export function visitPlace(trail: Trail, session: string): Trail {
  // Ignore an empty session id because it cannot identify a navigable session.
  if (!session) {
    return trail;
  }
  // Ignore a repeat visit to the current session.
  if (trailPlace(trail) === session) {
    return trail;
  }
  const places = trail.places.slice(0, trail.at + 1);
  places.push(session);
  return capped({ places, at: places.length - 1 });
}

export function stepBack(trail: Trail): Trail | null {
  return canStepBack(trail) ? { places: trail.places, at: trail.at - 1 } : null;
}

export function stepForward(trail: Trail): Trail | null {
  return canStepForward(trail) ? { places: trail.places, at: trail.at + 1 } : null;
}

// Removes visits to sessions that no longer exist.
export function prunePlaces(trail: Trail, live: Set<string>): Trail {
  return rebuild(trail, (place) => (live.has(place) ? place : null));
}

// Replaces provisional session ids with their actual ids before pruning.
export function renamePlace(trail: Trail, from: string, to: string): Trail {
  if (!from || !to || from === to) {
    return trail;
  }
  return rebuild(trail, (place) => (place === from ? to : place));
}

// Maps visited sessions, removes null results, and collapses adjacent duplicates.
// Preserve the nearest surviving position at or before the current one.
function rebuild(trail: Trail, next: (place: string) => string | null): Trail {
  const places: string[] = [];
  // Select the last surviving position at or before the current position.
  // If none survives there, select the oldest remaining session.
  let at = -1;
  for (let i = 0; i < trail.places.length; i += 1) {
    const place = next(trail.places[i]);
    if (place === null) {
      continue;
    }
    if (places[places.length - 1] !== place) {
      places.push(place);
    }
    if (i <= trail.at) {
      at = places.length - 1;
    }
  }
  return { places, at: places.length ? Math.max(at, 0) : -1 };
}

// Remove oldest visits while retaining the current position relative to the remaining list.
function capped(trail: Trail): Trail {
  if (trail.places.length <= PLACE_LIMIT) {
    return trail;
  }
  const over = trail.places.length - PLACE_LIMIT;
  return { places: trail.places.slice(over), at: trail.at - over };
}

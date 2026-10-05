// Where the reader has been, so that Back returns there.
//
// A place is a session. That is the whole of it today: the content search engine has no
// control that opens it, so there is no second kind of view to come back to, and a query
// nobody can type is not a place. When the rail's search control ships, a place gains the
// query beside the session and everything below keeps its shape.
//
// The walk is called a trail because the panel already says history for two other things: how
// far back a transcript is read, and the prompts the composer walks through with the Up
// arrow. A third meaning for the same word would make each of the three harder to read.

export interface Trail {
  // Oldest first. The reader moves along it and never edits it in the middle.
  places: string[];
  // Where the reader stands. Minus one on an empty trail, which is the only trail with
  // nowhere to stand.
  at: number;
}

// How far back the trail remembers. Old enough to cover an afternoon of moving between
// sessions, and short enough that the walk stays somewhere a person can hold.
export const PLACE_LIMIT = 50;

export function emptyTrail(): Trail {
  return { places: [], at: -1 };
}

// Where the trail stands now, or null when it stands nowhere.
export function trailPlace(trail: Trail): string | null {
  return trail.at >= 0 && trail.at < trail.places.length ? trail.places[trail.at] : null;
}

export function canStepBack(trail: Trail): boolean {
  return trail.at > 0;
}

export function canStepForward(trail: Trail): boolean {
  return trail.at >= 0 && trail.at < trail.places.length - 1;
}

// The reader went somewhere.
//
// A visit ends the forward walk, the way every browser does it: the places after this one
// describe a route the reader has just left, and keeping them would offer Forward into a
// past that no longer follows from here.
export function visitPlace(trail: Trail, session: string): Trail {
  // No session is not a place. The panel passes through this state whenever a draft is
  // abandoned or a transcript disappears, and recording it would put a stop on the trail
  // that draws nothing when the reader returns to it.
  if (!session) {
    return trail;
  }
  // Standing still. A second press on the session already open must not fill the trail
  // with a place the reader cannot tell from the one before it.
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

// The sessions that still exist. A draft the reader abandoned and a transcript that was
// deleted both leave a place pointing at nothing, and Back to nothing shows the newest
// session instead, which reads as the press having done something else entirely.
export function prunePlaces(trail: Trail, live: Set<string>): Trail {
  return rebuild(trail, (place) => (live.has(place) ? place : null));
}

// A draft is filed under an invented id until the agent reports the real one. The trail has
// to follow that rename, because the invented id stops existing the moment it is replaced and
// every place holding it would be pruned away.
export function renamePlace(trail: Trail, from: string, to: string): Trail {
  if (!from || !to || from === to) {
    return trail;
  }
  return rebuild(trail, (place) => (place === from ? to : place));
}

// Rewrite every place, dropping the ones that came back null, and leave the reader standing
// as close as possible to where they stood.
//
// Neighbours that become equal are folded into one. Removing B from A, B, A leaves the reader
// with two presses that both draw A, which looks like a Back that did nothing.
function rebuild(trail: Trail, next: (place: string) => string | null): Trail {
  const places: string[] = [];
  // Where the reader ends up: the last surviving place at or before where they stood, so a
  // pruned trail steps back rather than forward into places they have not seen. When the place
  // they stood on and everything before it has gone, the oldest survivor is the only answer
  // left, and it lies ahead of them.
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

// The oldest places go first. The reader walking back from the newest end reaches the cut
// long after they have stopped caring, and the alternative, refusing the newest place, would
// lose the one they are standing on.
function capped(trail: Trail): Trail {
  if (trail.places.length <= PLACE_LIMIT) {
    return trail;
  }
  const over = trail.places.length - PLACE_LIMIT;
  return { places: trail.places.slice(over), at: trail.at - over };
}

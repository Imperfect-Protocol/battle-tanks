# Battle Tanks Project Brief

## What We Are Building

Battle Tanks is a small realtime multiplayer tactics game built with a Vite React frontend and a Convex backend.

Players join the same room, each controls a tank, and each submits a short command script such as:

```text
bear 90
move 50
bear 180
move -30
aim 170
elev 30
pow 80
fire
```

The backend advances the shared game state one tick at a time. Every player sees the same board, tank positions, projectiles, health, queued orders, and match status update live without refreshing the page.

The first shippable version is intentionally simple:

- one square board with walls around the border
- two player slots
- one tank per player
- one ammunition type: missile
- command scripts with absolute bearing, movement, aim, elevation, power, and fire commands: `bear 90`, `move -30`, `aim 170`, `elev 30`, `pow 80`, and `fire`
- shared state synced through Convex
- frontend deployed through Convex Static Hosting on `convex.site`

The arena is 12 by 12 squares, and each square is stored as 1000 by 1000 internal game units. Tank and projectile locations can sit anywhere in the 12000 by 12000 unit coordinate space while the border wall still occupies the outer square of the arena. The match ticks at 25 frames per second. Movement uses acceleration and deceleration, capped at three squares per second. Movement commands use 10 command units per square, so `move 30` travels three squares forward and `move -30` travels three squares backward in the current hull bearing. Hull and turret rotation also happen over time: a full 360-degree rotation takes three seconds.

Hull, turret, and launch angles are continuous absolute bearings: `0` is north, `90` is east, `180` is south, and `270` is west. The `bear` command rotates the hull toward an absolute bearing. The `aim` command sets the turret's absolute horizontal bearing, `elev` sets the vertical launch angle, `pow` sets cannon power, and `fire` launches using the current cannon settings. Each command also has a single-letter abbreviation: `b`, `m`, `a`, `e`, `p`, and `f`. Values outside the allowed command ranges are rejected. At 100% power, launch velocity is calculated so 30 degrees flies about 8 squares, 45 degrees about 6 squares, and 60 degrees about 4 squares, with intermediate angles interpolated. Projectile impacts briefly become a large yellow-orange explosion. Impacts use a radius around the target tank center; damage is strongest at the center and falls off with a normal-distribution curve, with the hit radius tied to that damage curve's interquartile width.

The future version can add better maps, obstacles, richer projectiles, simultaneous turns, AI commanders, and smarter conditional orders.

## Why We Are Building It

The Multiplayer Convex challenge rewards products where shared realtime data is central to the experience. Battle Tanks is a direct fit because the game only works when every player sees the same arena state immediately.

The clear user problem is lightweight realtime coordination:

- Players need to understand what their teammate or opponent just did.
- Each action changes the shared situation for everyone.
- Command scripts make the game about planning, not reflexes.
- The same system can later support human players, scripted commanders, and AI commanders.

The demo should make the value obvious:

1. Open the same room in two browser sessions.
2. Join as two different commanders.
3. Submit orders from one session.
4. Watch the match tick continuously.
5. Show the other session updating instantly without a page reload.

That realtime proof is the heart of the project.

## How We Are Building It

The app has three main layers.

### Convex Backend

Convex stores the shared game state as plain serializable records:

- `boards`: board definitions, dimensions, walls, and spawn points
- `matches`: room code, board id, status, current tick, and winner
- `players`: commander name, slot, and score
- `tanks`: position, velocity, health, hull direction, turret direction, and selected ammo
- `orders`: command scripts queued by each player
- `projectiles`: active and spent missiles

Convex queries let every browser subscribe to the same room state. Convex mutations create rooms, join players, submit orders, and advance the next game tick.

### Domain Library

The frontend uses object-oriented domain classes in `src/libs`.

These classes wrap plain Convex records and keep responsibilities separated:

- `Player` remembers name, slot, and score.
- `Board` knows the arena size, walls, spawn points, and bounds checks.
- `Tank` knows its position, velocity, hull direction, health, and owned turret.
- `Turret` knows aim direction and ammunition.
- `Projectile` is the superclass for projectiles.
- `Missile` applies missile-specific impact behavior.
- `Orders` parses command scripts.
- `Commander` defines the command interface.
- `SimpleCommander` runs scripts deterministically.
- `GameRoom` collects board, players, tanks, projectiles, and orders into one useful object for React.

Convex does not store class instances. It stores JSON-like data, and the frontend hydrates those records into domain objects when behavior is useful.

### React Frontend

React hooks stay thin. They connect components to Convex and return domain objects or command functions.

The first hook is `useGameRoom(roomCode)`, which:

- subscribes to the room query
- creates a `GameRoom` object
- exposes `createRoom`, `joinRoom`, `submitScript`, and `runNextTick`

The UI focuses on the core multiplayer proof:

- room and commander controls
- command script input
- square tank arena
- live player health
- current tick and match status
- recent queued orders

## Friend Testing Plan

Two friends can help test the most important part of the project: whether the game feels realtime and understandable.

Ask them to try this:

1. Open the deployed app on separate devices or browser profiles.
2. Join room with different commander names.
3. Submit command scripts from both sessions.
4. Run ticks and watch whether both screens stay in sync.
5. Say where the game felt confusing, slow, unfair, or fun.

The best feedback is not about polish first. It is whether they can complete the main task: join the same room, issue orders, and see the shared battle update live.

## Scope Rules

The hackathon version should stay focused.

Build first:

- realtime room sync
- reliable two-player gameplay
- clear visual board
- simple commands
- public deployment
- demo evidence

Postpone:

- AI commander
- voice input
- WebRTC
- cryptography
- complex physics
- many projectile types
- custom map editor

Those ideas are valuable, but only after the simple shared-state game is working end to end.

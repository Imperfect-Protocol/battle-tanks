# Tank Battle

## End Of Game
- battle should end when all players but one are elliminated
- animations should continue after battle is finished
- battle ended dialog should show after 3 seconds from end of battle
- battle should be not showing in the lobby when it has finished rgardless of whether end of battle dialog is shown or close was clicked
- you must consider battle as finished when all players but one are elliminated,and not after player clicks Close button
- when creating new battle must ensure we don't reenter finished battle, create battle should always CREATE a battle and not join if name exists
- when user enters name of the battle that already exists red text below that name should way that name was already used

## Collisions
 - compute collision impact vector from normals of colliding objects:
    - wall: use wall direction N,S,W,E
    - tank: use vector from centre of the tank to collision point one the bounding shpere
    - collision vector is reflection vector:
        - two tanks are represented by two spheres: simulated impact as if two balls hit each other
        - tank vs wall represented as sphere vs plane: simulated impact as if ball hit a wall
        - impact force proportional to both objects velocity
        - rebound force proportional to impact force
 - collisions shouldn't make tanks stuck, they should push tank away using impact reflected vector
 - moving away from colliding object should not cause collision, only moving into an object. so test collision vector.

## Commands

 - bear <0-360 absolute bearing angle, 0 up/North, 90 right/East, 180 down/South, 270 left/West>
 - aim <0-360 absolute aiming angle, 0 up/North, 90 right/East, 180 down/South, 270 left/West> <10-60 vertical angle>
 - move < number of squares to move>
 - fire <10-100 power, value above 100 shoud print error>

Values out of range should print error

 
 ## Moving

 move should adhere to law of physics, tank have constant acceleration and speed is capped at maximum speed of 3 squares per second,
 when moving X squares tank should accelerate in current direction of its hull, and at some point should:
 - decelerate if there is no queued move commands
 - continue moving if there is queued move commands

Example

bear 90
move 5
bear 180
move 3
aim 200 30
fire 100

Here command queue has "move 5" and "move 3", so acceleration and deceleration should be computed using total distance of 5+3=8.
Tank should start decelerating soon enough to reach 0 at destination point.

If user queues another move command, say "move 3" then algorithm needs to add that to remaining distance, e.g.

move 5 + move 3 = move 8

already moved 7 ==> then remaining is 8 - 7 = 1

so queueing "move 3" should add 3: 1 + 3 = 4

tank should accelerate to reach destination at 4 squares.

- when tank is turning maximum acceleration is capped at  50%
- acceleration should be recomputed each time new commands are queued, or on collision, or impact
- tank at the moment of impact with projectile should loose 50% of its current speed, and should recompute acceleration

## Aiming 

Draw aiming target on the ground, each player should have color of aiming target that matches color of their tank.

Aiming target should be a cross with two circles of diameter 3/4 of square and 1/2 square centered in cross centre.
It should be exact location where projectile will hit the ground.

Projectile velocity needs to be calculated taking into account current tank velocity.
When tank is stopped projectile maximum velocity should be 6 squares per second.

Use either 50% of power or last used fire power to compute distance.

## Targeting

Draw target on opponent tank.
When opponent tank is moving compute target ahead of tank movement.
Make sure our player does not know commands of other player - they should be secret on server.
We should only compute target based on observed velocity of the opponent tank.


# AI integrartion

It should be possible to replace human with AI.

MCP should endpoint should be provided using:

https://www.convex.dev/components/convex-mcp-gateway


- AI should be able to issue tank commands.
- AI should be able to list games in the lobby, and join a game or create a new one
- AI should be able to list lobbies

# NavBar

There should be navigation bar at top with 

BATTLE TANKS logo (as is currently - no changes)
Lobbies - goes to main lobby listing lobbies
Settings - should open settings page

## Settings 

- Panel where user can see list of their commander, and button to switch which goes into commander selection screen
- Panel where user can click a button "Reset Password" which goes into reset password dialog
- Panel where user can configure MCP so they can connect their AI agent


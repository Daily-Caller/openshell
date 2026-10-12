# Openshell

This is a standard environment for working on our projects using Opencode inside an Openshell sandbox.

The bot is able to work freely within the sandbox constraints, but cannot write to the outside world.  Git commits must be reviewed and published by the user.

## Configuration

Copy `user-env.sample` to `user-env`, and edit it. You primarily need to put in your API key(s) and set models accordingly.

You can then go into opencode/ directory, add a cli.json and, if you want, a theme/ directory with custom themes.

## Startup

### Command Line

```
deno run -A sandbox.js <project name> <host path to project>
```

### Example

```
deno run -A sandbox.js dc-rambo /home/user/development/dc/rambo
```

## Operation

```
cd <project name>
opencode
```

import chalk from 'chalk';

type TextStyler = (text: string) => string;

const tuiWrap = (tag: string): TextStyler => (text: string) => `{${tag}}${text}{/${tag}}`;

export const theme = {
  text: {
    muted: chalk.gray,
    info: chalk.cyan,
    success: chalk.green,
    warning: chalk.yellow,
    error: chalk.red,
    heading: chalk.blue,
    strong: chalk.bold,
    readyYes: chalk.green,
    readyNo: chalk.hex('#FFA500'),
  },
  status: {
    open: chalk.greenBright,
    inProgress: chalk.cyan,
    blocked: chalk.redBright,
    completed: chalk.white,
    inputNeeded: chalk.yellow,
    deleted: chalk.gray,
  },
  stage: {
    idea: chalk.blueBright,
    intakeComplete: chalk.hex('#FFA500'),
    planComplete: chalk.white,
    inProgress: chalk.cyan,
    inReview: chalk.magenta,
    done: chalk.green,
  },
  priority: {
    critical: chalk.redBright,
    high: chalk.yellowBright,
    medium: chalk.blueBright,
    low: chalk.gray,
  },
  tui: {
    colors: {
      lightText: 'white',
    },
    text: {
      // Use a named gray foreground so blessed/markup recognizes the tag
      // and renders a consistent muted/grey color in the TUI.
      muted: tuiWrap('gray-fg'),
      info: tuiWrap('cyan-fg'),
      success: tuiWrap('green-fg'),
      warning: tuiWrap('yellow-fg'),
      error: tuiWrap('red-fg'),
      shellCommand: tuiWrap('214-fg'),
      shellOutput: tuiWrap('white-fg'),
      readyYes: tuiWrap('green-fg'),
      readyNo: tuiWrap('214-fg'),
    },
    status: {
      open: tuiWrap('green-fg'),
      inProgress: tuiWrap('cyan-fg'),
      blocked: tuiWrap('red-fg'),
      completed: tuiWrap('white-fg'),
      inputNeeded: tuiWrap('yellow-fg'),
      deleted: tuiWrap('gray-fg'),
    },
    stage: {
      idea: tuiWrap('blue-fg'),
      intakeComplete: tuiWrap('214-fg'),
      planComplete: tuiWrap('white-fg'),
      inProgress: tuiWrap('cyan-fg'),
      inReview: tuiWrap('magenta-fg'),
      done: tuiWrap('green-fg'),
    },
  },
} as const;

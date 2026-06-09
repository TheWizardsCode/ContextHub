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
  // Blocked status override: always red, regardless of stage
  blocked: chalk.redBright,
  // Stage-progression colours: gray → blue → cyan → yellow → green → white
  stage: {
    idea: chalk.gray,
    intakeComplete: chalk.blue,
    planComplete: chalk.cyan,
    inProgress: chalk.yellow,
    inReview: chalk.green,
    done: chalk.white,
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
    // Blocked status override: always red, regardless of stage
    blocked: tuiWrap('red-fg'),
    // Stage-progression colours: gray → blue → cyan → yellow → green → white
    stage: {
      idea: tuiWrap('gray-fg'),
      intakeComplete: tuiWrap('blue-fg'),
      planComplete: tuiWrap('cyan-fg'),
      inProgress: tuiWrap('yellow-fg'),
      inReview: tuiWrap('green-fg'),
      done: tuiWrap('white-fg'),
    },
  },
} as const;

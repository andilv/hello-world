// index.ts
function greet(name: string = "World"): string {
  return `Hello, ${name}!`;
}

function greetLoudly(name: string = "World"): string {
  return `HELLO, ${name.toUpperCase()}!!!`;
}

export {
  greet,
  greetLoudly
};
// index.js
function greet(name = "World") {
  return `Hello, ${name}!`;
}

function greetLoudly(name = "World") {
  return `HELLO, ${name.toUpperCase()}!!!`;
}

module.exports = {
  greet,
  greetLoudly
};
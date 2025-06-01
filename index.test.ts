import { greet, greetLoudly } from './index';

describe('greet', () => {
  test('should greet with "Hello, World!" by default', () => {
    expect(greet()).toBe('Hello, World!');
  });

  test('should greet a person with "Hello, [name]!"', () => {
    expect(greet('Alice')).toBe('Hello, Alice!');
  });
});

describe('greetLoudly', () => {
  test('should greet loudly with "HELLO, WORLD!!!" by default', () => {
    expect(greetLoudly()).toBe('HELLO, WORLD!!!');
  });

  test('should greet a person loudly with "HELLO, [NAME]!!!"', () => {
    expect(greetLoudly('Bob')).toBe('HELLO, BOB!!!');
  });
});

import { Registry } from './registry';
import { Class } from './types';

test('class registry', () => {
  const registry = new Registry<Class>(c => c.name);

  class Car {
    honk() {
      console.log('honk');
    }
  }
  registry.register(Car);

  expect(registry.getValue('Car')).toBe(Car);
  expect(registry.getIdentifier(Car)).toBe('Car');

  expect(() => registry.register(Car)).not.toThrow();

  expect(() => registry.register(class Car {})).toThrow(
    'Ambiguous class, provide a unique identifier.'
  );

  registry.unregister(Car);

  expect(registry.getValue('Car')).toBeUndefined();

  registry.register(Car, 'car1');

  registry.register(class Car {}, 'car2');

  expect(registry.getValue('car1')).toBe(Car);

  expect(registry.getValue('car2')).not.toBeUndefined();

  registry.clear();

  expect(registry.getValue('car1')).toBeUndefined();
});

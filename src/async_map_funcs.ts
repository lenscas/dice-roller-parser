export async function async_reduce<T, U>(
  array: T[],
  func: (prev: U, cur: T, index: number) => Promise<U>,
  init: U
): Promise<U> {
  for (let index = 0; index < array.length; index++) {
    const element = array[index];
    init = await func(init, element, index);
  }
  return init;
}

export async function async_map<T, U>(
  array: T[],
  func: (cur: T, index: number) => Promise<U>
): Promise<U[]> {
  return await Promise.all(array.map(func));
}

export async function async_filter<T>(
  array: T[],
  func: (cur: T, index: number) => Promise<boolean>
): Promise<T[]> {
  const newArr = [];
  for (let index = 0; index < array.length; index++) {
    const element = array[index];
    if (await func(element, index)) {
      newArr.push(element);
    }
  }
  return newArr;
}

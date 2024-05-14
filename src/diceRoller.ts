// tslint:disable-next-line: no-var-requires
const parser = require("./diceroll.js");
import { async_filter, async_map, async_reduce } from "./async_map_funcs";
import {
  RootType,
  DiceRoll,
  NumberType,
  InlineExpression,
  RollExpressionType,
  MathType,
  GroupedRoll,
  SortRollType,
  SuccessFailureCritModType,
  ReRollMod,
  FullRoll,
  ParsedType,
  MathExpression,
  KeepDropModType,
  SuccessFailureModType,
  MathFunctionExpression,
  CustomReplacementExpression,
} from "./parsedRollTypes";
import {
  RollBase,
  DiceExpressionRoll,
  GroupRoll,
  DiceRollResult,
  DieRollBase,
  ExpressionRoll,
  DieRoll,
  FateDieRoll,
  GroupedRollBase,
  MathFunctionRoll,
  ReplacementRoll,
} from "./rollTypes";

// TODO: [[ {[[1d6]], 5}kh1 ]] fails due to white space "[[ {" - perhaps add .?* to pegjs file to allow optional spaces

export class DiceRoller {
  public randFunction: () => number = Math.random;
  public replacementFunctions: (_: string) => Promise<(_: number) => number> =
    async () => (x: number) =>
      x;
  public maxRollCount = 1000;

  public cached: { [key: string]: (_: number) => number } = {};
  /**
   * The DiceRoller class that performs parsing and rolls of {@link https://wiki.roll20.net/Dice_Reference roll20 format} input strings
   * @constructor
   * @param randFunction The random number generator function to use when rolling, default: Math.random
   * @param maxRolls The max number of rolls to perform for a single die, default: 1000
   */
  constructor(
    randFunction?: () => number,
    maxRolls = 1000,
    replacementFunctions?: (_: string) => Promise<(_: number) => number>
  ) {
    if (randFunction) {
      this.randFunction = randFunction;
    }
    if (replacementFunctions) {
      this.replacementFunctions = replacementFunctions;
    }
    this.maxRollCount = maxRolls;
  }

  /**
   * Parses and returns an representation of a dice roll input string
   * @param input The input string to parse
   * @returns A {@link RootType} object representing the parsed input string
   */
  public parse(input: string): RootType {
    return parser.parse(input);
  }

  /**
   * Parses and rolls a dice roll input string, returning an object representing the roll
   * @param input The input string to parse
   * @returns A {@link RollBase} object representing the rolled dice input string
   */
  public async roll(input: string): Promise<RollBase> {
    const root = parser.parse(input);
    return await this.rollType(root);
  }

  /**
   * Parses and rolls a dice roll input string, returning the result as a number
   * @param input The input string to parse
   * @returns The final number value of the result
   */
  public async rollValue(input: string): Promise<number> {
    return (await this.roll(input)).value;
  }

  /**
   * Rolls a previously parsed dice roll input string, returning an object representing the roll
   * @param parsed A parsed input as a {@link RootType} string to be rolled
   * @returns A {@link RollBase} object representing the rolled dice input string
   */
  public async rollParsed(parsed: RootType): Promise<RollBase> {
    return await this.rollType(parsed);
  }

  private async rollType(input: RootType): Promise<RollBase> {
    let response: RollBase;

    switch (input.type) {
      case "diceExpression":
        response = await this.rollDiceExpr(input as RollExpressionType);
        break;
      case "group":
        response = await this.rollGroup(input as GroupedRoll);
        break;
      case "die":
        response = await this.rollDie(input as DiceRoll);
        break;
      case "expression":
        response = await this.rollExpression(input as MathExpression);
        break;
      case "mathfunction":
        response = await this.rollFunction(input as MathFunctionExpression);
        break;
      case "replacement":
        response = await this.doReplacement(
          input as CustomReplacementExpression
        );
        break;
      case "inline":
        response = await this.rollType((input as InlineExpression).expr);
        break;
      case "number":
        response = {
          ...(input as NumberType),
          success: null,
          successes: 0,
          failures: 0,
          valid: true,
          order: 0,
        };
        break;
      default:
        throw new Error(`Unable to render ${input.type}`);
    }

    if (input.label) {
      response.label = input.label;
    }

    return response;
  }

  private async rollDiceExpr(
    input: RollExpressionType
  ): Promise<DiceExpressionRoll> {
    const headRoll = await this.rollType(input.head);
    const rolls = [headRoll];
    const ops: ("+" | "-")[] = [];

    const value = await async_reduce(
      input.ops,
      async (headValue, math, order: number) => {
        const tailRoll = await this.rollType(math.tail);
        tailRoll.order = order;

        rolls.push(tailRoll);
        ops.push(math.op);

        switch (math.op) {
          case "+":
            return headValue + tailRoll.value;
          case "-":
            return headValue - tailRoll.value;
          default:
            return headValue;
        }
      },
      headRoll.value
    );

    return {
      dice: rolls,
      ops,
      success: null,
      successes: 0,
      failures: 0,
      type: "diceexpressionroll",
      valid: true,
      value,
      order: 0,
    };
  }

  private async rollGroup(input: GroupedRoll): Promise<GroupRoll> {
    let rolls: RollBase[] = await async_map(
      input.rolls,
      async (roll, order) => ({
        ...(await this.rollType(roll)),
        order,
      })
    );
    let successes = 0;
    let failures = 0;
    let hasTarget = false;

    // TODO: single sub roll vs. multiple sub rolls -- https://wiki.roll20.net/Dice_Reference#Grouped_Roll_Modifiers

    if (input.mods) {
      const mods = input.mods;
      const applyGroupMods = async (dice: RollBase[]) => {
        hasTarget = mods.some((mod) =>
          ["failure", "success"].includes(mod.type)
        );
        dice = await async_reduce(
          mods,
          (arr, mod) => this.applyGroupMod(arr, mod),
          dice
        );

        if (hasTarget) {
          dice = dice.map((die) => {
            successes += die.successes;
            failures += die.failures;
            die.value = die.successes - die.failures;
            die.success = die.value > 0;
            return die;
          });
        }

        return dice;
      };

      if (
        rolls.length === 1 &&
        ["die", "diceexpressionroll"].includes(rolls[0].type)
      ) {
        const roll = rolls[0];
        let dice =
          roll.type === "die"
            ? (roll as DiceRollResult).rolls
            : (roll as DiceExpressionRoll).dice
                .filter((die) => die.type !== "number")
                .reduce(
                  (arr: RollBase[], die) => [
                    ...arr,
                    ...(die.type === "die"
                      ? (die as DiceRollResult).rolls
                      : (die as GroupedRollBase).dice),
                  ],
                  []
                );

        dice = await applyGroupMods(dice);
        roll.value = dice.reduce(
          (sum, die) => (die.valid ? sum + die.value : sum),
          0
        );
      } else {
        rolls = await applyGroupMods(rolls);
      }
    }

    const value = rolls.reduce(
      (sum, roll) => (!roll.valid ? sum : sum + roll.value),
      0
    );

    return {
      dice: rolls,
      success: hasTarget ? value > 0 : null,
      successes,
      failures,
      type: "grouproll",
      valid: true,
      value,
      order: 0,
    };
  }

  private async rollDie(input: FullRoll): Promise<DiceRollResult> {
    const count = await this.rollType(input.count);

    if (count.value > this.maxRollCount) {
      throw new Error("Entered number of dice too large.");
    }

    let rolls: DieRollBase[];
    let die: RollBase;
    if (input.die.type === "fate") {
      die = {
        type: "fate",
        success: null,
        successes: 0,
        failures: 0,
        valid: false,
        value: 0,
        order: 0,
      };
      rolls = Array.from({ length: count.value }, (_, i) =>
        this.generateFateRoll(i)
      );
    } else {
      die = await this.rollType(input.die);
      rolls = Array.from({ length: count.value }, (_, i) =>
        this.generateDiceRoll(die.value, i)
      );
    }

    if (input.mods) {
      rolls = await async_reduce(
        input.mods,
        async (moddedRolls, mod) => await this.applyMod(moddedRolls, mod),
        rolls
      );
    }

    let successes = 0;
    let failures = 0;

    if (input.targets) {
      rolls = (
        await async_reduce(
          input.targets,

          async (moddedRolls, target) =>
            await this.applyMod(moddedRolls, target),
          rolls
        )
      ).map((roll) => {
        successes += roll.successes;
        failures += roll.failures;
        roll.value = roll.successes - roll.failures;
        roll.success = roll.value > 0;
        return roll;
      });
    }

    let matched = false;
    let matchCount = 0;
    if (input.match) {
      const match = input.match;
      const counts = rolls.reduce(
        (map: Map<number, number>, roll) =>
          map.set(roll.roll, (map.get(roll.roll) || 0) + 1),
        new Map()
      );

      const matches = new Set(
        (
          await async_filter(
            Array.from(counts.entries()).filter(
              ([_, matchedCount]) => matchedCount >= match.min.value
            ),
            async ([val]) =>
              !(match.mod && match.expr) ||
              this.successTest(
                match.mod,
                (
                  await this.rollType(match.expr)
                ).value,
                val
              )
          )
        ).map(([val]) => val)
      );

      rolls
        .filter((roll) => matches.has(roll.roll))
        .forEach((roll) => (roll.matched = true));

      if (match.count) {
        matched = true;
        matchCount = matches.size;
      }
    }

    if (input.sort) {
      rolls = this.applySort(rolls, input.sort);
    }

    const value = rolls.reduce(
      (sum, roll) => (!roll.valid ? sum : sum + roll.value),
      0
    );

    return {
      count,
      die,
      rolls,
      success: input.targets ? value > 0 : null,
      successes,
      failures,
      type: "die",
      valid: true,
      value: matched ? matchCount : value,
      order: 0,
      matched,
    };
  }

  private async rollExpression(
    input: RollExpressionType | MathExpression
  ): Promise<ExpressionRoll> {
    const headRoll = await this.rollType(input.head);
    const rolls = [headRoll];
    const ops: ("+" | "-" | "*" | "/" | "%" | "**")[] = [];

    const value = await async_reduce(
      input.ops as MathType<any>[],
      async (headValue: number, math) => {
        const tailRoll = await this.rollType(math.tail);
        rolls.push(tailRoll);
        ops.push(math.op);

        switch (math.op) {
          case "+":
            return headValue + tailRoll.value;
          case "-":
            return headValue - tailRoll.value;
          case "*":
            return headValue * tailRoll.value;
          case "/":
            return headValue / tailRoll.value;
          case "%":
            return headValue % tailRoll.value;
          case "**":
            return headValue ** tailRoll.value;
          default:
            return headValue;
        }
      },
      headRoll.value
    );

    return {
      dice: rolls,
      ops,
      success: null,
      successes: 0,
      failures: 0,
      type: "expressionroll",
      valid: true,
      value,
      order: 0,
    };
  }

  private async doReplacement(
    input: CustomReplacementExpression
  ): Promise<ReplacementRoll> {
    const roll = await this.rollType(input.expr);
    const replaceFunctionName = input.called;

    if (!this.cached[replaceFunctionName]) {
      this.cached[replaceFunctionName] = await this.replacementFunctions(
        replaceFunctionName
      );
    }
    const replaceFunction = this.cached[replaceFunctionName];
    const value = replaceFunction(roll.value);
    return {
      called: replaceFunctionName,
      expr: roll,
      failures: 0,
      op: "custom",
      order: 0,
      successes: 0,
      type: "replacement",
      valid: true,
      value,
      success: true,
    };
  }

  private async rollFunction(
    input: MathFunctionExpression
  ): Promise<MathFunctionRoll> {
    const expr = await this.rollType(input.expr);

    let value: number;
    switch (input.op) {
      case "floor":
        value = Math.floor(expr.value);
        break;
      case "ceil":
        value = Math.ceil(expr.value);
        break;
      case "round":
        value = Math.round(expr.value);
        break;
      case "abs":
        value = Math.abs(expr.value);
        break;
      default:
        value = expr.value;
        break;
    }

    return {
      expr,
      op: input.op,
      success: null,
      successes: 0,
      failures: 0,
      type: "mathfunction",
      valid: true,
      value,
      order: 0,
    };
  }

  private async applyGroupMod(
    rolls: RollBase[],
    mod: ParsedType
  ): Promise<RollBase[]> {
    return (await this.getGroupModMethod(mod))(rolls);
  }

  private async getGroupModMethod(mod: ParsedType): Promise<GroupModMethod> {
    const lookup = (roll: RollBase) => roll.value;
    switch (mod.type) {
      case "success":
        return await this.getSuccessMethod(
          mod as SuccessFailureModType,
          lookup
        );
      case "failure":
        return await this.getFailureMethod(
          mod as SuccessFailureModType,
          lookup
        );
      case "keep":
        return await this.getKeepMethod(mod as KeepDropModType, lookup);
      case "drop":
        return await this.getDropMethod(mod as KeepDropModType, lookup);
      default:
        throw new Error(`Mod ${mod.type} is not recognised`);
    }
  }

  private async applyMod(
    rolls: DieRollBase[],
    mod: ParsedType
  ): Promise<DieRollBase[]> {
    return (await this.getModMethod(mod))(rolls);
  }

  private async getModMethod(mod: ParsedType): Promise<ModMethod> {
    const lookup = (roll: DieRollBase) => roll.roll;
    switch (mod.type) {
      case "success":
        return await this.getSuccessMethod(
          mod as SuccessFailureCritModType,
          lookup
        );
      case "failure":
        return await this.getFailureMethod(
          mod as SuccessFailureCritModType,
          lookup
        );
      case "crit":
        return await this.getCritSuccessMethod(
          mod as SuccessFailureCritModType,
          lookup
        );
      case "critfail":
        return this.getCritFailureMethod(
          mod as SuccessFailureCritModType,
          lookup
        );
      case "keep":
        return async (rolls) =>
          (
            await (
              await this.getKeepMethod(mod as KeepDropModType, lookup)
            )(rolls)
          ).sort((a, b) => a.order - b.order);
      case "drop":
        return async (rolls) =>
          (
            await (
              await this.getDropMethod(mod as KeepDropModType, lookup)
            )(rolls)
          ).sort((a, b) => a.order - b.order);
      case "explode":
        return this.getExplodeMethod(mod as ReRollMod);
      case "compound":
        return this.getCompoundMethod(mod as ReRollMod);
      case "penetrate":
        return this.getPenetrateMethod(mod as ReRollMod);
      case "reroll":
        return this.getReRollMethod(mod as ReRollMod);
      case "rerollOnce":
        return this.getReRollOnceMethod(mod as ReRollMod);
      default:
        throw new Error(`Mod ${mod.type} is not recognised`);
    }
  }

  private applySort(rolls: DieRollBase[], mod: SortRollType) {
    rolls.sort((a, b) => (mod.asc ? a.roll - b.roll : b.roll - a.roll));
    rolls.forEach((roll, i) => (roll.order = i));
    return rolls;
  }

  private async getCritSuccessMethod<T extends DieRollBase>(
    mod: SuccessFailureCritModType,
    lookup: (roll: T) => number
  ) {
    const exprResult = await this.rollType(mod.expr);

    return async (rolls: T[]) => {
      return rolls.map((roll) => {
        if (!roll.valid) return roll;
        if (roll.type !== "roll") return roll;
        if (roll.success) return roll;

        const critRoll = roll as unknown as DieRoll;
        if (this.successTest(mod.mod, exprResult.value, lookup(roll))) {
          critRoll.critical = "success";
        } else if (critRoll.critical === "success") {
          critRoll.critical = null;
        }

        return roll;
      });
    };
  }

  private async getCritFailureMethod<T extends DieRollBase>(
    mod: SuccessFailureCritModType,
    lookup: (roll: T) => number
  ) {
    const exprResult = await this.rollType(mod.expr);

    return async (rolls: T[]) => {
      return rolls.map((roll) => {
        if (!roll.valid) return roll;
        if (roll.type !== "roll") return roll;
        if (roll.success) return roll;

        const critRoll = roll as unknown as DieRoll;
        if (this.successTest(mod.mod, exprResult.value, lookup(roll))) {
          critRoll.critical = "failure";
        } else if (critRoll.critical === "failure") {
          critRoll.critical = null;
        }

        return roll;
      });
    };
  }

  private async getSuccessMethod<T extends RollBase>(
    mod: SuccessFailureCritModType,
    lookup: (roll: T) => number
  ) {
    const exprResult = await this.rollType(mod.expr);

    return async (rolls: T[]) => {
      return rolls.map((roll) => {
        if (!roll.valid) {
          return roll;
        }

        if (this.successTest(mod.mod, exprResult.value, lookup(roll))) {
          roll.successes += 1;
        }
        return roll;
      });
    };
  }

  private async getFailureMethod<T extends RollBase>(
    mod: SuccessFailureCritModType,
    lookup: (roll: T) => number
  ) {
    const exprResult = await this.rollType(mod.expr);

    return async (rolls: T[]) => {
      return rolls.map((roll) => {
        if (!roll.valid) {
          return roll;
        }

        if (this.successTest(mod.mod, exprResult.value, lookup(roll))) {
          roll.failures += 1;
        }
        return roll;
      });
    };
  }

  private async getKeepMethod<T extends RollBase>(
    mod: KeepDropModType,
    lookup: (roll: T) => number
  ) {
    const exprResult = await this.rollType(mod.expr);

    return async (rolls: T[]) => {
      if (rolls.length === 0) return rolls;

      rolls = rolls
        .sort((a, b) =>
          mod.highlow === "l" ? lookup(b) - lookup(a) : lookup(a) - lookup(b)
        )
        .sort((a, b) => (a.valid ? 1 : 0) - (b.valid ? 1 : 0));

      const toKeep = Math.max(Math.min(exprResult.value, rolls.length), 0);
      let dropped = 0;
      let i = 0;

      const toDrop =
        rolls.reduce((value, roll) => (roll.valid ? 1 : 0) + value, 0) - toKeep;

      while (i < rolls.length && dropped < toDrop) {
        if (rolls[i].valid) {
          rolls[i].valid = false;
          rolls[i].drop = true;
          dropped++;
        }

        i++;
      }

      return rolls;
    };
  }

  private async getDropMethod<T extends RollBase>(
    mod: KeepDropModType,
    lookup: (roll: T) => number
  ) {
    const exprResult = await this.rollType(mod.expr);

    return async (rolls: T[]) => {
      rolls = rolls.sort((a, b) =>
        mod.highlow === "h" ? lookup(b) - lookup(a) : lookup(a) - lookup(b)
      );

      const toDrop = Math.max(Math.min(exprResult.value, rolls.length), 0);
      let dropped = 0;
      let i = 0;

      while (i < rolls.length && dropped < toDrop) {
        if (rolls[i].valid) {
          rolls[i].valid = false;
          rolls[i].drop = true;
          dropped++;
        }

        i++;
      }

      return rolls;
    };
  }

  private async getExplodeMethod(mod: ReRollMod) {
    const targetValue = mod.target
      ? await this.rollType(mod.target.value)
      : null;

    return async (rolls: DieRollBase[]) => {
      const targetMethod = targetValue
        ? (roll: DieRollBase) =>
            this.successTest(mod.target.mod, targetValue.value, roll.roll)
        : (roll: DieRollBase) =>
            this.successTest(
              "=",
              roll.type === "fateroll" ? 1 : (roll as DieRoll).die,
              roll.roll
            );

      if (
        rolls[0].type === "roll" &&
        targetMethod({ roll: 1 } as DieRollBase) &&
        targetMethod({ roll: (rolls[0] as DieRoll).die } as DieRollBase)
      ) {
        throw new Error("Invalid reroll target");
      }

      for (let i = 0; i < rolls.length; i++) {
        let roll = rolls[i];
        roll.order = i;
        let explodeCount = 0;

        while (targetMethod(roll) && explodeCount++ < 1000) {
          roll.explode = true;
          const newRoll = this.reRoll(roll, ++i);
          rolls.splice(i, 0, newRoll);
          roll = newRoll;
        }
      }

      return rolls;
    };
  }

  private async getCompoundMethod(mod: ReRollMod) {
    const targetValue = mod.target
      ? await this.rollType(mod.target.value)
      : null;

    return async (rolls: DieRollBase[]) => {
      const targetMethod = targetValue
        ? (roll: DieRollBase) =>
            this.successTest(mod.target.mod, targetValue.value, roll.roll)
        : (roll: DieRollBase) =>
            this.successTest(
              "=",
              roll.type === "fateroll" ? 1 : (roll as DieRoll).die,
              roll.roll
            );

      if (
        rolls[0].type === "roll" &&
        targetMethod({ roll: 1 } as DieRollBase) &&
        targetMethod({ roll: (rolls[0] as DieRoll).die } as DieRollBase)
      ) {
        throw new Error("Invalid reroll target");
      }

      for (let i = 0; i < rolls.length; i++) {
        let roll = rolls[i];
        let rollValue = roll.roll;
        let explodeCount = 0;

        while (targetMethod(roll) && explodeCount++ < 1000) {
          roll.explode = true;
          const newRoll = this.reRoll(roll, i + 1);
          rollValue += newRoll.roll;
          roll = newRoll;
        }

        rolls[i].value = rollValue;
        rolls[i].roll = rollValue;
      }

      return rolls;
    };
  }

  private async getPenetrateMethod(mod: ReRollMod) {
    const targetValue = mod.target
      ? await this.rollType(mod.target.value)
      : null;

    return async (rolls: DieRollBase[]) => {
      const targetMethod = targetValue
        ? (roll: DieRollBase) =>
            this.successTest(mod.target.mod, targetValue.value, roll.roll)
        : (roll: DieRollBase) =>
            this.successTest(
              "=",
              roll.type === "fateroll" ? 1 : (roll as DieRoll).die,
              roll.roll
            );

      if (
        targetValue &&
        rolls[0].type === "roll" &&
        targetMethod(rolls[0]) &&
        this.successTest(mod.target.mod, targetValue.value, 1)
      ) {
        throw new Error("Invalid reroll target");
      }

      for (let i = 0; i < rolls.length; i++) {
        let roll = rolls[i];
        roll.order = i;
        let explodeCount = 0;

        while (targetMethod(roll) && explodeCount++ < 1000) {
          roll.explode = true;
          const newRoll = this.reRoll(roll, ++i);
          newRoll.value -= 1;
          // newRoll.roll -= 1;
          rolls.splice(i, 0, newRoll);
          roll = newRoll;
        }
      }

      return rolls;
    };
  }

  private async getReRollMethod(mod: ReRollMod) {
    const targetMethod = mod.target
      ? this.successTest.bind(
          null,
          mod.target.mod,
          (await this.rollType(mod.target.value)).value
        )
      : this.successTest.bind(null, "=", 1);

    return async (rolls: DieRollBase[]) => {
      if (
        rolls[0].type === "roll" &&
        targetMethod(1) &&
        targetMethod((rolls[0] as DieRoll).die)
      ) {
        throw new Error("Invalid reroll target");
      }

      for (let i = 0; i < rolls.length; i++) {
        while (targetMethod(rolls[i].roll)) {
          rolls[i].reroll = true;
          rolls[i].valid = false;
          const newRoll = this.reRoll(rolls[i], i + 1);
          rolls.splice(++i, 0, newRoll);
        }
      }

      return rolls;
    };
  }

  private async getReRollOnceMethod(mod: ReRollMod) {
    const targetMethod = mod.target
      ? this.successTest.bind(
          null,
          mod.target.mod,
          (await this.rollType(mod.target.value)).value
        )
      : this.successTest.bind(null, "=", 1);

    return async (rolls: DieRollBase[]) => {
      if (
        rolls[0].type === "roll" &&
        targetMethod(1) &&
        targetMethod((rolls[0] as DieRoll).die)
      ) {
        throw new Error("Invalid reroll target");
      }

      for (let i = 0; i < rolls.length; i++) {
        if (targetMethod(rolls[i].roll)) {
          rolls[i].reroll = true;
          rolls[i].valid = false;
          const newRoll = this.reRoll(rolls[i], i + 1);
          rolls.splice(++i, 0, newRoll);
        }
      }

      return rolls;
    };
  }

  private successTest(mod: string, target: number, roll: number) {
    switch (mod) {
      case ">":
        return roll >= target;
      case "<":
        return roll <= target;
      case "=":
      default:
        // tslint:disable-next-line: triple-equals
        return roll == target;
    }
  }

  private reRoll(roll: DieRollBase, order: number): DieRollBase {
    switch (roll.type) {
      case "roll":
        return this.generateDiceRoll((roll as DieRoll).die, order);
      case "fateroll":
        return this.generateFateRoll(order);
      default:
        throw new Error(`Cannot do a reroll of a ${roll.type}.`);
    }
  }

  private generateDiceRoll(die: number, order: number): DieRoll {
    // const roll = Math.floor(this.randFunction() * die) + 1;
    // avoid floating math errors like .29 * 100 = 28.999999999999996
    const roll = parseInt((this.randFunction() * die).toFixed(), 10) + 1;

    const critical = roll === die ? "success" : roll === 1 ? "failure" : null;

    return {
      critical,
      die,
      matched: false,
      order,
      roll,
      success: null,
      successes: 0,
      failures: 0,
      type: "roll",
      valid: true,
      value: roll,
    };
  }

  private generateFateRoll(order: number): FateDieRoll {
    const roll = Math.floor(this.randFunction() * 3) - 1;

    return {
      matched: false,
      order,
      roll,
      success: null,
      successes: 0,
      failures: 0,
      type: "fateroll",
      valid: true,
      value: roll,
    };
  }
}

type ModMethod = (rolls: DieRollBase[]) => Promise<DieRollBase[]>;
type GroupModMethod = (rolls: RollBase[]) => Promise<RollBase[]>;

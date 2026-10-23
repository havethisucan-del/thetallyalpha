import * as Phaser from 'phaser';

/** What the canvas shows. Derived from the server view by the caller; no rules here. */
export interface BoardModel {
  counter: number;
  target: number;
  turnLabel: string;
  secretCounts: [number, number];
  mySeat: 0 | 1;
  statusLabel: string;
}

export interface BoardHandle {
  update(model: BoardModel): void;
  destroy(): void;
}

const WIDTH = 640;
const HEIGHT = 300;

class BoardScene extends Phaser.Scene {
  #model: BoardModel | null = null;
  #texts: {
    counter: Phaser.GameObjects.Text;
    turn: Phaser.GameObjects.Text;
    status: Phaser.GameObjects.Text;
    seats: [Phaser.GameObjects.Text, Phaser.GameObjects.Text];
  } | null = null;
  #bar: Phaser.GameObjects.Rectangle | null = null;

  constructor() {
    super({ key: 'board' });
  }

  create(): void {
    const style = { fontFamily: 'system-ui, sans-serif', color: '#e2e8f0' };
    this.add.rectangle(WIDTH / 2, 110, WIDTH - 80, 24, 0x334155).setOrigin(0.5);
    this.#bar = this.add.rectangle(40, 110, 0, 24, 0x0ea5e9).setOrigin(0, 0.5);
    this.#texts = {
      counter: this.add.text(WIDTH / 2, 50, '', { ...style, fontSize: '36px' }).setOrigin(0.5),
      turn: this.add.text(WIDTH / 2, 160, '', { ...style, fontSize: '24px' }).setOrigin(0.5),
      status: this.add
        .text(WIDTH / 2, 200, '', { ...style, fontSize: '18px', color: '#94a3b8' })
        .setOrigin(0.5),
      seats: [
        this.add.text(40, 250, '', { ...style, fontSize: '18px' }).setOrigin(0, 0.5),
        this.add.text(WIDTH - 40, 250, '', { ...style, fontSize: '18px' }).setOrigin(1, 0.5),
      ],
    };
    this.#render();
  }

  setModel(model: BoardModel): void {
    this.#model = model;
    this.#render();
  }

  #render(): void {
    const model = this.#model;
    const texts = this.#texts;
    if (!model || !texts || !this.#bar) return;
    texts.counter.setText(`${model.counter} / ${model.target}`);
    const ratio = model.target > 0 ? Math.min(1, Math.max(0, model.counter / model.target)) : 0;
    this.#bar.setSize((WIDTH - 80) * ratio, 24);
    texts.turn.setText(model.turnLabel);
    texts.status.setText(model.statusLabel);
    for (const seat of [0, 1] as const) {
      const who = seat === model.mySeat ? 'You' : 'Opponent';
      texts.seats[seat].setText(`${who}: ${model.secretCounts[seat]} secrets`);
    }
  }
}

/** Creates the Phaser game inside `parent`. No assets are loaded; only shapes and text. */
export function createBoard(parent: HTMLElement): BoardHandle {
  const scene = new BoardScene();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: WIDTH,
    height: HEIGHT,
    backgroundColor: '#0f172a',
    banner: false,
    audio: { noAudio: true },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_HORIZONTALLY },
    scene,
  });
  return {
    update(model) {
      scene.setModel(model);
    },
    destroy() {
      game.destroy(true);
    },
  };
}

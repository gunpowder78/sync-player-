import { SyncPlayerStatus } from "../../Types";
import { isPlaybackRateEqual } from "../../utils/playbackrate";
import type { AtomPlayerConfig, AtomPlayerEvents } from "../AtomPlayer";
import { AtomPlayer } from "../AtomPlayer";

export interface ClusterPlayerConfig extends AtomPlayerConfig {
  rowPlayer: AtomPlayer;
  colPlayer: AtomPlayer;
}

export class ClusterPlayer extends AtomPlayer {
  private readonly rowPlayer: AtomPlayer;
  private readonly colPlayer: AtomPlayer;

  private longerPlayer: AtomPlayer;

  public constructor(config: ClusterPlayerConfig) {
    super({
      name:
        config.name ||
        `{${config.rowPlayer.name || "unknown"}-${
          config.colPlayer.name || "unknown"
        }}`,
    });

    this.rowPlayer = config.rowPlayer;
    this.colPlayer = config.colPlayer;

    this.longerPlayer =
      this.rowPlayer.duration >= this.colPlayer.duration
        ? this.rowPlayer
        : this.colPlayer;

    this.duration = this.longerPlayer.duration;
    this.playbackRate = this.longerPlayer.playbackRate;

    const addAtomListener = (
      event: AtomPlayerEvents,
      listener: (emitter: AtomPlayer, receptor: AtomPlayer) => void
    ): void => {
      this._sideEffect.add(() => {
        const handler = (): void => {
          listener(this.rowPlayer, this.colPlayer);
        };
        this.rowPlayer.on(event, handler);
        return (): void => {
          this.rowPlayer.off(event, handler);
        };
      });
      this._sideEffect.add(() => {
        const handler = (): void => {
          listener(this.colPlayer, this.rowPlayer);
        };
        this.colPlayer.on(event, handler);
        return (): void => {
          this.colPlayer.off(event, handler);
        };
      });
    };

    addAtomListener("status", (emitter, receptor) => {
      if (!this.ignoreSetStatus) {
        this.syncSubPlayer(emitter, receptor);
        this.updateStatus(emitter, receptor);
        if (
          this.rowPlayer.status === SyncPlayerStatus.Playing &&
          this.colPlayer.status === SyncPlayerStatus.Playing
        ) {
          this.startFrameDropCheck();
        } else {
          this.stopFrameDropCheck?.();
        }
      }
    });

    addAtomListener("timeupdate", emitter => {
      if (
        this.longerPlayer === emitter &&
        emitter.status !== SyncPlayerStatus.Ended
      ) {
        this.currentTime = emitter.currentTime;
      }
    });

    addAtomListener("durationchange", (emitter, receptor) => {
      if (emitter.duration >= this.longerPlayer.duration) {
        if (emitter !== this.longerPlayer) {
          this.longerPlayer = emitter;
        }
      } else {
        this.longerPlayer = receptor;
      }
      this.duration = this.longerPlayer.duration;
    });

    addAtomListener("ratechange", emitter => {
      if (!isPlaybackRateEqual(emitter.playbackRate, this.playbackRate)) {
        this.playbackRate = emitter.playbackRate;
      }
    });
  }

  public override destroy(): void {
    super.destroy();
    this.stopFrameDropCheck?.();
    this.rowPlayer.destroy();
    this.colPlayer.destroy();
  }

  public override get isReady(): boolean {
    return this.rowPlayer.isReady && this.colPlayer.isReady;
  }

  public override async ready(silently?: boolean): Promise<void> {
    await this.readyImpl(silently);
  }

  public override async play(): Promise<void> {
    // Do not check this.status !== SyncPlayerStatus.Playing
    // since one sub-player may not be playing
    if (this.status !== SyncPlayerStatus.Ended) {
      await this.playImpl();
    }
  }

  public override async pause(): Promise<void> {
    await this.pauseImpl();
  }

  public override async stop(): Promise<void> {
    await this.stopImpl();
  }

  public override async seek(ms: number): Promise<void> {
    await this.seekImpl(ms);
  }

  protected async readyImpl(silently?: boolean): Promise<void> {
    await this.invokeSubPlayers(player => player.ready(silently));
  }

  protected async playImpl(): Promise<void> {
    await this.invokeSubPlayers(player => player.play());
  }

  protected async pauseImpl(): Promise<void> {
    await this.invokeSubPlayers(player => player.pause());
  }

  protected async stopImpl(): Promise<void> {
    await this.invokeSubPlayers(player => player.stop());
  }

  protected async seekImpl(ms: number): Promise<void> {
    await Promise.all([this.rowPlayer.seek(ms), this.colPlayer.seek(ms)]);
  }

  protected setPlaybackRateImpl(value: number): void {
    this.rowPlayer.setPlaybackRate(value);
    this.colPlayer.setPlaybackRate(value);
  }

  private updateStatus(emitter: AtomPlayer, receptor: AtomPlayer): void {
    switch (emitter.status) {
      case SyncPlayerStatus.Ready: {
        switch (receptor.status) {
          case SyncPlayerStatus.Ready:
          case SyncPlayerStatus.Ended: {
            this.status = SyncPlayerStatus.Ready;
            break;
          }
        }
        break;
      }

      case SyncPlayerStatus.Pause: {
        if (receptor.status !== SyncPlayerStatus.Playing) {
          this.status = SyncPlayerStatus.Pause;
        }
        break;
      }

      case SyncPlayerStatus.Buffering: {
        if (receptor.status !== SyncPlayerStatus.Pause) {
          this.status = SyncPlayerStatus.Buffering;
        }
        break;
      }

      case SyncPlayerStatus.Playing: {
        switch (receptor.status) {
          case SyncPlayerStatus.Playing:
          case SyncPlayerStatus.Ended: {
            this.status = SyncPlayerStatus.Playing;
            break;
          }
        }
        break;
      }

      case SyncPlayerStatus.Ended: {
        this.status = receptor.status;
        break;
      }
    }
  }

  private async syncSubPlayer(
    emitter: AtomPlayer,
    receptor: AtomPlayer
  ): Promise<void> {
    switch (emitter.status) {
      case SyncPlayerStatus.Pause: {
        if (receptor.isPlaying) {
          await receptor.pause();
        }
        break;
      }

      case SyncPlayerStatus.Buffering: {
        if (receptor.status === SyncPlayerStatus.Playing) {
          await receptor.ready();
        }
        break;
      }

      case SyncPlayerStatus.Playing: {
        if (receptor.status === SyncPlayerStatus.Buffering) {
          await emitter.ready();
        } else if (
          receptor.status === SyncPlayerStatus.Ready &&
          (receptor.duration <= 0 || emitter.currentTime < receptor.duration)
        ) {
          await receptor.play();
        }
        break;
      }
    }
  }

  private stopFrameDropCheck?: () => void;
  private startFrameDropCheck(): void {
    if (this.stopFrameDropCheck) {
      return;
    }

    let frameDropCount = 0;
    const ticket = setInterval(async () => {
      if (this.status !== SyncPlayerStatus.Playing) {
        frameDropCount = 0;
      } else {
        const diff = this.rowPlayer.currentTime - this.colPlayer.currentTime;
        frameDropCount = Math.abs(diff) > 1000 ? frameDropCount + 1 : 0;
        if (frameDropCount >= 2) {
          // handle frame drops
          if (diff < 0) {
            await this.rowPlayer.seek(this.colPlayer.currentTime);
          } else {
            await this.colPlayer.seek(this.rowPlayer.currentTime);
          }
          frameDropCount = 0;
        }
      }
    }, 2000);

    this.stopFrameDropCheck = (): void => {
      this.stopFrameDropCheck = undefined;
      clearInterval(ticket);
    };
  }

  private async invokeSubPlayers(
    action: (player: AtomPlayer) => unknown
  ): Promise<void> {
    await Promise.all(
      [this.rowPlayer, this.colPlayer]
        .filter(player => player.status !== SyncPlayerStatus.Ended)
        .map(action)
    );
  }
}

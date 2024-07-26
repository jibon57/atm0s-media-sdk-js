import EventEmitter from 'eventemitter3';

import {
  Kind,
  Receiver,
  Receiver_Config,
  Receiver_Source,
  Receiver_State,
} from './generated/protobuf/shared';
import { ReadyWaiter } from './utils';
import { Datachannel, DatachannelEvent } from './data';
import { kindToString } from './types';
import { ServerEvent_Receiver } from './generated/protobuf/session';
import { TrackReceiverStatus } from './';

const DEFAULT_CFG = {
  priority: 1,
  maxSpatial: 2,
  maxTemporal: 2,
};

export enum TrackReceiverEvent {
  StatusUpdated = 'StatusUpdated',
  VoiceActivity = 'VoiceActivity',
}

export class TrackReceiver extends EventEmitter {
  private transceiver?: RTCRtpTransceiver;
  private waiter: ReadyWaiter = new ReadyWaiter();
  private readonly _mediaStream: MediaStream;
  private media_track?: MediaStreamTrack;
  private receiver_state: Receiver_State = {
    config: undefined,
    source: undefined,
  };
  private _status?: TrackReceiverStatus;
  private _attachedSource: Receiver_Source;
  private _trackName: string;

  constructor(
    private dc: Datachannel,
    private _peer: string,
    private _track: string,
    private _kind: Kind,
  ) {
    super();

    this._trackName = _peer + '_' + _track + '_' + kindToString(_kind);
    this._mediaStream = new MediaStream();
    this._attachedSource = {
      peer: this._peer,
      track: this._track,
    };

    console.log('[TrackReceiver] create ', this._trackName, dc);
    this.dc.on(
      DatachannelEvent.RECEIVER + this._trackName,
      (event: ServerEvent_Receiver) => {
        if (event.state) {
          this._status = event.state.status;
          this.emit(TrackReceiverEvent.StatusUpdated, this._status);
        } else if (event.voiceActivity) {
          this.emit(TrackReceiverEvent.VoiceActivity, event.voiceActivity);
        }
      },
    );
  }

  public get kind() {
    return this._kind;
  }

  public get webrtcTrackId() {
    return this.media_track?.id;
  }

  public get mediaStream() {
    return this._mediaStream;
  }

  public get status(): TrackReceiverStatus | undefined {
    return this._status;
  }

  public get attachedSource() {
    return this._attachedSource;
  }

  public setTrackReady = () => {
    this.waiter.setReady();
  };

  public ready = async () => {
    return this.waiter.waitReady();
  };

  /// We need lazy prepare for avoding error when sender track is changed before it connect.
  /// Config after init feature will be useful when complex application
  public prepare = (peer: RTCPeerConnection) => {
    this.transceiver = peer.addTransceiver(kindToString(this._kind), {
      direction: 'recvonly',
    });
    this._mediaStream.addTrack(this.transceiver.receiver.track);
    this.media_track = this.transceiver.receiver.track;
  };

  public attach = async (config: Receiver_Config = DEFAULT_CFG) => {
    this.receiver_state.config = config;
    this.receiver_state.source = this._attachedSource;
    this._status = TrackReceiverStatus.WAITING;
    this.emit(TrackReceiverEvent.StatusUpdated, this._status);

    //if we in prepare state, we dont need to access to server, just update local
    if (!this.transceiver) {
      console.log('[TrackReceiver] attach on prepare state');
      return;
    }

    await this.dc.ready();
    await this.ready();
    await this.dc.requestReceiver({
      name: this._trackName,
      attach: {
        source: this.receiver_state.source,
        config: this.receiver_state.config,
      },
    });
  };

  public detach = async () => {
    delete this.receiver_state.source;
    delete this.receiver_state.config;
    delete this._status;
    this.emit(TrackReceiverEvent.StatusUpdated, undefined);

    //if we in prepare state, we dont need to access to server, just update local
    if (!this.transceiver) {
      console.log('[TrackReceiver] detach on prepare state');
      return;
    }

    await this.dc.ready();
    await this.ready();
    await this.dc.requestReceiver({
      name: this._trackName,
      detach: {},
    });
  };

  public config = async (config: Receiver_Config) => {
    this.receiver_state.config = config;

    //if we in prepare state, we dont need to access to server, just update local
    if (!this.transceiver) {
      console.log('[TrackReceiver] config on prepare state');
      return;
    }

    await this.dc.ready();
    await this.ready();
    await this.dc.requestReceiver({
      name: this._trackName,
      config,
    });
  };

  // We need to reset local state when leave room
  public leaveRoom = () => {
    this.receiver_state.source = undefined;
  };

  public get name(): string {
    return this._trackName;
  }

  public get state(): Receiver {
    return {
      name: this.name,
      kind: this.kind,
      state: this.receiver_state,
    };
  }
}

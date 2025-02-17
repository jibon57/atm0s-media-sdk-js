import EventEmitter from 'eventemitter3';

import {
  ConnectRequest,
  ConnectResponse,
  RemoteIceRequest,
  RemoteIceResponse,
} from './generated/protobuf/gateway';
import { TrackReceiver } from './receiver';
import { TrackSender, TrackSenderConfig } from './sender';
import { postProtobuf } from './utils';
import { Datachannel, DatachannelEvent } from './data';
import {
  Request_Session_UpdateSdp,
  ServerEvent_Room,
  ServerEvent_Room_PeerLeaved,
  ServerEvent_Room_TrackStarted,
  ServerEvent_Room_TrackStopped,
} from './generated/protobuf/session';
import * as mixer from './features/audio_mixer';
import { Kind, Receiver_Status } from './generated/protobuf/shared';
import { TrackSenderStatus } from './index';

export interface JoinInfo {
  room: string;
  peer: string;
  metadata?: string;
  publish: { peer: boolean; tracks: boolean };
  subscribe: { peers: boolean; tracks: boolean };
  features?: {
    mixer?: mixer.AudioMixerConfig;
  };
}

export interface SessionConfig {
  token: string;
  join?: JoinInfo;
}

export enum SessionEvent {
  ROOM_CHANGED = 'room.changed',
  ROOM_PEER_JOINED = 'room.peer.joined',
  ROOM_PEER_UPDATED = 'room.peer.updated',
  ROOM_PEER_LEAVED = 'room.peer.leaved',
  ROOM_TRACK_STARTED = 'room.track.started',
  ROOM_TRACK_UPDATED = 'room.track.updated',
  ROOM_TRACK_STOPPED = 'room.track.stopped',
  ROOM_DISCONNECTED = 'room.disconnected',
}

export class Session extends EventEmitter {
  private ice_lite: boolean = false;
  private readonly created_at: number;
  private version?: string;
  private conn_id?: string;
  private readonly _peer: RTCPeerConnection;
  private readonly dc: Datachannel;
  private receivers: TrackReceiver[] = [];
  private senders: TrackSender[] = [];
  private _mixer?: mixer.AudioMixer;

  /// Prepaer state for flagging when ever this peer is created offer.
  /// This flag is useful for avoiding tranceiver config is changed before it connect
  private prepareState: boolean = true;

  constructor(
    private gateway: string,
    private cfg: SessionConfig,
  ) {
    super();
    this.created_at = new Date().getTime();
    console.warn('Create session', this.created_at);
    this._peer = new RTCPeerConnection();
    this.dc = new Datachannel(
      this._peer.createDataChannel('data', { negotiated: true, id: 1000 }),
    );
    this.dc.on(DatachannelEvent.ROOM, async (event: ServerEvent_Room) => {
      if (event.peerJoined) {
        this.emit(SessionEvent.ROOM_PEER_JOINED, event.peerJoined);
      } else if (event.peerUpdated) {
        this.emit(SessionEvent.ROOM_PEER_UPDATED, event.peerUpdated);
      } else if (event.peerLeaved) {
        await this.onAfterPeerLeave(event.peerLeaved);
      } else if (event.trackStarted) {
        this.onAfterTrackStarted(event.trackStarted);
      } else if (event.trackUpdated) {
        this.emit(SessionEvent.ROOM_TRACK_UPDATED, event.trackUpdated);
      } else if (event.trackStopped) {
        await this.onRoomTrackStopped(event.trackStopped);
      }
    });

    //TODO add await to throtle for avoiding too much update in short time
    this._peer.onnegotiationneeded = () => {
      if (this.dc.connected)
        this.syncSdp().then(console.log).catch(console.error);
    };

    this._peer.onconnectionstatechange = () => {
      console.log(
        '[Session] RTCPeer connection state changed',
        this._peer.connectionState,
      );
    };

    this._peer.oniceconnectionstatechange = () => {
      console.log(
        '[Session] RTCPeer ice state changed',
        this._peer.iceConnectionState,
      );
    };

    this._peer.ontrack = (event) => {
      for (let i = 0; i < this.receivers.length; i++) {
        const receiver = this.receivers[i]!;
        if (receiver.webrtcTrackId == event.track.id) {
          console.log(
            '[Session] found receiver for track',
            receiver.name,
            event.track,
          );
          receiver.setTrackReady();
          return;
        }
      }
      console.warn('[Session] not found receiver for track', event.track);
    };

    this._peer.onicecandidate = async (event) => {
      if (event.candidate && !this.ice_lite) {
        const req = RemoteIceRequest.create({
          candidates: [event.candidate.candidate],
        });
        console.log('Send ice-candidate', event.candidate.candidate);
        const res = await postProtobuf(
          RemoteIceRequest,
          RemoteIceResponse,
          this.gateway + '/webrtc/' + this.conn_id + '/ice-candidate',
          req,
          {
            'Content-Type': 'application/grpc',
          },
        );
        console.log('Sent ice-candidate', res);
      }
    };

    //init audios
    if (cfg.join?.features?.mixer) {
      this._mixer = new mixer.AudioMixer(
        this,
        this.dc,
        cfg.join.features.mixer,
      );
    }
  }

  public get room() {
    return this.cfg.join;
  }

  public get mixer() {
    return this._mixer;
  }

  public get peer() {
    return this._peer;
  }

  // public receiver = (kind: Kind): TrackReceiver => {
  //   const kind_str = kindToString(kind);
  //   const track_name = kind_str + '_' + this.receivers.length;
  //   const receiver = new TrackReceiver(this.dc, track_name, kind);
  //   if (!this.prepareState) {
  //     receiver.prepare(this._peer);
  //   }
  //   this.receivers.push(receiver);
  //   console.log('Created receiver', kind, track_name);
  //   return receiver;
  // };

  public sender = (
    track_name: string,
    track_or_kind: MediaStreamTrack | Kind,
    cfg?: TrackSenderConfig,
  ) => {
    const sender = new TrackSender(this.dc, track_name, track_or_kind, cfg);
    if (!this.prepareState) {
      sender.prepare(this._peer);
    }
    this.senders.push(sender);
    console.log('Created sender', sender.kind, track_name);
    return sender;
  };

  public connect = async (version?: string) => {
    if (!this.prepareState) {
      throw new Error('Not in prepare state');
    }
    this.prepareState = false;
    this.version = version;
    console.warn('Prepare senders and receivers to connect');
    //prepare for senders. We need to lazy prepare because some transceiver dont allow update before connected
    for (let i = 0; i < this.senders.length; i++) {
      console.log('Prepare sender ', this.senders[i]!.name);
      this.senders[i]!.prepare(this._peer);
    }
    //prepare for receivers. We need to lazy prepare because some transceiver dont allow update before connected
    for (let i = 0; i < this.receivers.length; i++) {
      console.log('Prepare receiver ', this.receivers[i]!.name);
      this.receivers[i]!.prepare(this._peer);
    }
    console.log('Prepare offer for connect');
    const local_desc = await this._peer.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    const req = ConnectRequest.create({
      version: version || 'pure-ts@0.0.0', //TODO auto get from package.json
      join: this.cfg.join && {
        room: this.cfg.join.room,
        peer: this.cfg.join.peer,
        metadata: this.cfg.join.metadata,
        publish: this.cfg.join.publish,
        subscribe: this.cfg.join.subscribe,
        features: { mixer: this.mixer?.state() },
      },
      tracks: {
        receivers: this.receivers.map((r) => r.state),
        senders: this.senders.map((r) => r.state),
      },
      sdp: local_desc.sdp,
    });
    console.log('Connecting');

    const res = await postProtobuf(
      ConnectRequest,
      ConnectResponse,
      this.gateway + '/webrtc/connect',
      req,
      {
        Authorization: 'Bearer ' + this.cfg.token,
        'Content-Type': 'application/grpc',
      },
    );

    if (res.connId === '' || res.connId === '') {
      throw new Error('connection was not successful');
    }

    this.conn_id = res.connId;
    this.ice_lite = res.iceLite;
    await this._peer.setLocalDescription(local_desc);
    await this._peer.setRemoteDescription({ type: 'answer', sdp: res.sdp });
    await this.dc.ready();
    console.log('Connected');
  };

  public restartIce = async () => {
    //TODO detect disconnect state and call restart-ice
    const local_desc = await this._peer.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    const req = ConnectRequest.create({
      version: this.version || 'pure-ts@0.0.0', //TODO auto get from package.json
      join: this.cfg.join && {
        room: this.cfg.join.room,
        peer: this.cfg.join.peer,
        metadata: this.cfg.join.metadata,
        publish: this.cfg.join.publish,
        subscribe: this.cfg.join.subscribe,
        features: { mixer: this.mixer?.state() },
      },
      tracks: {
        receivers: this.receivers.map((r) => r.state),
        senders: this.senders.map((r) => r.state),
      },
      sdp: local_desc.sdp,
    });
    console.log('Sending restart-ice request');
    const res = await postProtobuf(
      ConnectRequest,
      ConnectResponse,
      this.gateway + '/webrtc/' + this.conn_id + '/restart-ice',
      req,
      {
        Authorization: 'Bearer ' + this.cfg.token,
        'Content-Type': 'application/grpc',
      },
    );
    this.ice_lite = res.iceLite;
    console.log('Apply restart-ice response');
    if (this.conn_id !== res.connId) {
      console.log(
        'Session connect to new server, reset receivers for handling new recv tracks',
      );
      this.conn_id = res.connId;
      this.receivers.map((r) => {
        r.mediaStream.removeTrack(r.mediaStream.getTracks()[0]!);
      }, []);
    }
    await this._peer.setLocalDescription(local_desc);
    await this._peer.setRemoteDescription({ type: 'answer', sdp: res.sdp });
  };

  public join = async (info: JoinInfo, token: string) => {
    // We need to create new mixer or reconfig it according to new info.
    // In case of newer room dont have mixer, we just reject it and remain old mixer,
    // the server don't send any update in this case.
    if (info.features?.mixer) {
      if (this._mixer) {
        this._mixer.reconfig(info.features.mixer);
      } else {
        this._mixer = new mixer.AudioMixer(this, this.dc, info.features.mixer);
      }
    }
    await this.dc.requestSession({
      join: {
        info: {
          room: info.room,
          peer: info.peer,
          metadata: info.metadata,
          publish: info.publish,
          subscribe: info.subscribe,
          features: { mixer: this.mixer?.state() },
        },
        token,
      },
    });
    this.cfg.join = info;
    this.cfg.token = token;
    this.emit(SessionEvent.ROOM_CHANGED, info);
  };

  private syncSdp = async () => {
    const local_desc = await this._peer.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    const update_sdp = Request_Session_UpdateSdp.create({
      tracks: {
        receivers: this.receivers.map((r) => r.state),
        senders: this.senders.map((r) => r.state),
      },
      sdp: local_desc.sdp,
    });

    console.log('Requesting update sdp', update_sdp);
    const res = await this.dc.requestSession({
      sdp: update_sdp,
    });
    console.log('Request update sdp success', res);
    await this._peer.setLocalDescription(local_desc);
    await this._peer.setRemoteDescription({
      type: 'answer',
      sdp: res.sdp!.sdp,
    });
  };

  public leave = async () => {
    //reset local here
    this.receivers.map((r) => r.leaveRoom());
    this.mixer?.leave_room();

    await this.dc.requestSession({
      leave: {},
    });
    this.cfg.join = undefined;
    this.emit(SessionEvent.ROOM_CHANGED, undefined);
  };

  public disconnect = async () => {
    console.warn('Disconnect session', this.created_at);

    // first let's close all the remote tracks
    for (let i = 0; i < this.receivers.length; i++) {
      const receiver = this.receivers[i];
      if (receiver && receiver.status === Receiver_Status.ACTIVE) {
        await receiver.detach();
      }
    }
    this.receivers = [];

    // local tracks
    // first let's close all the remote tracks
    for (let i = 0; i < this.senders.length; i++) {
      const sender = this.senders[i];
      if (sender && sender.status === TrackSenderStatus.ACTIVE) {
        // now detach
        await sender.detach();
      }
    }
    this.senders = [];

    // leave from session
    await this.leave();

    // close peer
    this._peer.close();
    // finally emit event
    this.emit(SessionEvent.ROOM_DISCONNECTED);
  };

  private onAfterPeerLeave = async (event: ServerEvent_Room_PeerLeaved) => {
    // we'll look for this peer's medias & remove those
    for (let i = 0; i < this.receivers.length; i++) {
      const receiver = this.receivers[i];
      if (receiver && receiver.attachedSource?.peer === event.peer) {
        if (receiver.status === Receiver_Status.ACTIVE) {
          await receiver.detach();
          receiver.leaveRoom();
        }
        this.receivers = this.receivers.splice(i, 1);
      }
    }
    this.emit(SessionEvent.ROOM_PEER_LEAVED, event);
  };

  private onRoomTrackStopped = async (event: ServerEvent_Room_TrackStopped) => {
    //we'll look for this peer's medias & remove those
    for (let i = 0; i < this.receivers.length; i++) {
      const receiver = this.receivers[i];
      if (
        receiver &&
        receiver.attachedSource?.peer === event.peer &&
        receiver.attachedSource?.track === event.track
      ) {
        if (receiver.status === Receiver_Status.ACTIVE) {
          await receiver.detach();
        }
        this.receivers = this.receivers.splice(i, 1);
      }
    }
    this.emit(SessionEvent.ROOM_TRACK_STOPPED, event);
  };

  private onAfterTrackStarted = async (
    event: ServerEvent_Room_TrackStarted,
  ) => {
    const receiver = new TrackReceiver(
      this.dc,
      event.peer,
      event.track,
      event.kind,
    );
    if (!this.prepareState) {
      receiver.prepare(this._peer);
    }
    this.receivers.push(receiver);

    this.emit(SessionEvent.ROOM_TRACK_STARTED, receiver);
  };
}

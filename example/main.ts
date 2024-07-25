import {
  BitrateControlMode,
  Kind,
  Session,
  SessionEvent,
  TrackSender,
} from '../src';
import { getToken } from './token.ts';
import {
  ServerEvent_Room_PeerJoined,
  ServerEvent_Room_PeerLeaved,
  ServerEvent_Room_PeerUpdated,
  ServerEvent_Room_TrackStarted,
  ServerEvent_Room_TrackStopped,
  ServerEvent_Room_TrackUpdated,
} from '../src/generated/protobuf/session.ts';
import { JoinInfo } from '../src/session.ts';
import { Sender_Status } from '../src/generated/protobuf/shared.ts';

let session: Session | undefined = undefined;
let audioSender: TrackSender | undefined = undefined;
let videoSender: TrackSender | undefined = undefined;

const createSession = async (
  gatewayUrl: string,
  secret: string,
  roomId: string,
  peerId: string,
) => {
  let token: string;
  try {
    token = await getToken(gatewayUrl, secret, roomId, peerId);
  } catch (e) {
    console.error(e);
    return;
  }

  const _session = new Session(gatewayUrl, {
    token,
    join: {
      room: roomId,
      peer: peerId,
      publish: { peer: true, tracks: true },
      subscribe: { peers: true, tracks: true },
    },
  });

  _session.on(SessionEvent.ROOM_CHANGED, onRoomChanged);
  _session.on(SessionEvent.ROOM_PEER_JOINED, onPeerJoined);
  _session.on(SessionEvent.ROOM_PEER_LEAVED, onPeerLeaved);
  _session.on(SessionEvent.ROOM_PEER_UPDATED, onPeerUpdated);
  _session.on(SessionEvent.ROOM_TRACK_STARTED, onTrackStarted);
  _session.on(SessionEvent.ROOM_TRACK_UPDATED, onTrackUpdated);
  _session.on(SessionEvent.ROOM_TRACK_STOPPED, onTrackStopped);
  _session.on(SessionEvent.ROOM_DISCONNECTED, () => (session = undefined));

  await _session.connect();
  if (_session.peer.connectionState === 'connected') {
    session = _session;
  }
};

export const connect = async (
  gatewayUrl: string,
  secret: string,
  roomId: string,
  peerId: string,
) => {
  if (session !== undefined) {
    console.log('peer connection state', session.peer.connectionState);
    if (session.peer.connectionState !== 'connected') {
      await session.connect();
    }
    return;
  }

  await createSession(gatewayUrl, secret, roomId, peerId);
};

const onRoomChanged = (info: JoinInfo) => {
  console.log('onRoomChanged', info);
};
const onPeerJoined = (event: ServerEvent_Room_PeerJoined) => {
  console.log('onPeerJoined', event);
};
const onPeerLeaved = (event: ServerEvent_Room_PeerLeaved) => {
  console.log('onPeerLeaved', event);
};

const onPeerUpdated = (event: ServerEvent_Room_PeerUpdated) => {
  console.log('onPeerUpdated', event);
};
const onTrackStarted = async (event: ServerEvent_Room_TrackStarted) => {
  console.log('onTrackStarted', event);
  if (session === undefined) {
    return;
  }
  if (event.kind === Kind.AUDIO) {
    const audioRec = session.receiver(Kind.AUDIO);
    audioRec.attach(event);

    const remoteAudioNode = document.getElementById(
      'remoteAudio',
    ) as HTMLAudioElement;
    remoteAudioNode.srcObject = audioRec.stream;
  } else if (event.kind === Kind.VIDEO) {
    const videoRec = session.receiver(Kind.VIDEO);
    videoRec.attach(event);

    const remoteVideoNode = document.getElementById(
      'remoteVideo',
    ) as HTMLVideoElement;

    remoteVideoNode.srcObject = videoRec.stream;
  }
};
const onTrackUpdated = (event: ServerEvent_Room_TrackUpdated) => {
  console.log('onTrackUpdated', event);
};

const onTrackStopped = (event: ServerEvent_Room_TrackStopped) => {
  console.log('onTrackStopped', event);

  if (event.kind == Kind.AUDIO) {
    const remoteAudioNode = document.getElementById(
      'remoteAudio',
    ) as HTMLAudioElement;
    remoteAudioNode.srcObject = null;
  } else if (event.kind == Kind.VIDEO) {
    const remoteVideoNode = document.getElementById(
      'remoteVideo',
    ) as HTMLVideoElement;
    remoteVideoNode.srcObject = null;
  }
};

const mediaShare = async () => {
  if (session === undefined) {
    return;
  }
  const audioStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
  });
  audioSender = session.sender('audio_main', audioStream.getAudioTracks()[0]);

  const videoStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: true,
  });

  videoSender = session.sender('video_main', videoStream.getVideoTracks()[0], {
    priority: 100,
    bitrate: BitrateControlMode.DYNAMIC_CONSUMERS,
    metadata: 'Video stream metadata',
  });

  const localVideo = document.getElementById('local') as HTMLVideoElement;
  localVideo.srcObject = videoStream;
};

const disconnect = () => {
  if (session === undefined) {
    return;
  }

  session.disconnect();
};

window.addEventListener('load', () => {
  const gateway = document.getElementById('gatewayUrl') as HTMLInputElement;
  const secret = document.getElementById('secret') as HTMLInputElement;
  const roomId = document.getElementById('roomId') as HTMLInputElement;
  const peerId = document.getElementById('peerId') as HTMLInputElement;

  const time = Date.now();
  //roomId.value = 'room_' + time;
  peerId.value = 'peer_' + time;

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error
  document.getElementById('connect').addEventListener('click', async (e) => {
    e.preventDefault();
    await connect(gateway.value, secret.value, roomId.value, peerId.value);
  });

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error
  document.getElementById('mediaShare').addEventListener('click', async (e) => {
    e.preventDefault();
    await mediaShare();
  });

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error
  document.getElementById('disMedia').addEventListener('click', async (e) => {
    e.preventDefault();
    if (audioSender && videoSender) {
      if (audioSender.status === Sender_Status.ACTIVE) {
        console.log('closing...', audioSender.name);
        audioSender.track?.stop();
        await audioSender.detach();
      }
      if (videoSender.status === Sender_Status.ACTIVE) {
        console.log('closing...', videoSender.name);
        videoSender.track?.stop();
        await videoSender.detach();
      }
    }
  });

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error
  document.getElementById('disconnect').addEventListener('click', async (e) => {
    e.preventDefault();
    disconnect();
  });
});

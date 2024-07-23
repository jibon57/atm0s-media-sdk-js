import {Session, SessionEvent} from '../src';
import {getToken} from "./token.ts";
import {ServerEvent_Room_PeerJoined} from "../src/generated/protobuf/session.ts";

const connect = async () => {
  console.log('connect!');
  let token: string;
  try {
     token = await getToken("http://localhost:3001", "secr3t", "911", "11");
  }catch (e) {
    console.error(e);
    return;
  }

  console.log(token)

  const session = new Session("http://localhost:3001", {
    token,
    join: {
      room: "911",
      peer: "11",
      publish: { peer: true, tracks: true },
      subscribe: { peers: true, tracks: true },
    }
  })
  
  session.on(SessionEvent.ROOM_PEER_JOINED, onPeerJoined)
};

const onPeerJoined = (event: ServerEvent_Room_PeerJoined) => {
  console.log(event)
}

connect();

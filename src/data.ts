import EventEmitter from 'eventemitter3';

import {
  ClientEvent,
  Request as ProtoRequest,
  Request_Receiver,
  Request_Sender,
  Request_Session,
  Response as ProtoResponse,
  Response_Receiver,
  Response_Sender,
  Response_Session,
  ServerEvent,
} from './generated/protobuf/session';
import {
  Request as RequestMixer,
  Response as ResponseMixer,
} from './generated/protobuf/features.mixer';
import { ReadyWaiter } from './utils';

export enum DatachannelEvent {
  ROOM = 'event.room',
  SESSION = 'event.session',
  SENDER = 'event.sender.',
  RECEIVER = 'event.receiver.',
  FEATURE_MIXER = 'event.features.mixer',
}

export class Datachannel extends EventEmitter {
  private waiter: ReadyWaiter = new ReadyWaiter();
  private seq_id: number = 0;
  private req_id: number = 0;
  private reqs: Map<number, (_: ProtoResponse) => void> = new Map();
  private prepare_state = true;

  constructor(private dc: RTCDataChannel) {
    super();
    dc.onopen = () => {
      console.log('[Datachannel] on open');
      this.waiter.setReady();
    };
    dc.onmessage = (e) => {
      const msg = ServerEvent.decode(new Uint8Array(e.data));

      console.log('[Datachannel] on event', msg);
      if (msg.room) {
        this.emit(DatachannelEvent.ROOM, msg.room);
      } else if (msg.session) {
        this.emit(DatachannelEvent.SESSION, msg.room);
      } else if (msg.sender) {
        this.emit(DatachannelEvent.SENDER + msg.sender.name, msg.sender);
      } else if (msg.receiver) {
        this.emit(DatachannelEvent.RECEIVER + msg.receiver.name, msg.receiver);
      } else if (msg.features) {
        if (msg.features.mixer) {
          this.emit(DatachannelEvent.FEATURE_MIXER, msg.features.mixer);
        }
      } else if (msg.response) {
        const req_cb = this.reqs.get(msg.response.reqId);
        if (req_cb) {
          console.log('[Datachannel] on response', msg.response);
          this.reqs.delete(msg.response.reqId);
          req_cb(msg.response);
        } else {
          console.warn(
            '[Datachannel] unknown request with response',
            msg.response,
          );
        }
      }
    };
    dc.onerror = (e) => {
      console.error('[Datachannel] on error', e);
      this.waiter.setError(e);
    };
    dc.onclose = () => {
      console.log('[Datachannel] on close');
    };
  }

  public get connected() {
    return this.dc.readyState == 'open';
  }

  public ready = async (): Promise<void> => {
    return this.waiter.waitReady();
  };

  public requestSession = async (
    req: Request_Session,
  ): Promise<Response_Session> => {
    const reqId = this.gen_req_id();
    const res = await this.request({ reqId, session: req });
    if (res.session) {
      return res.session;
    } else {
      throw Error('INVALID_SERVER_RESPONSE');
    }
  };

  public requestSender = async (
    req: Request_Sender,
  ): Promise<Response_Sender> => {
    const reqId = this.gen_req_id();
    const res = await this.request({ reqId, sender: req });
    if (res.sender) {
      return res.sender;
    } else {
      throw Error('INVALID_SERVER_RESPONSE');
    }
  };

  public requestReceiver = async (
    req: Request_Receiver,
  ): Promise<Response_Receiver> => {
    const reqId = this.gen_req_id();
    const res = await this.request({ reqId, receiver: req });
    if (res.receiver) {
      return res.receiver;
    } else {
      throw Error('INVALID_SERVER_RESPONSE');
    }
  };

  public requestMixer = async (req: RequestMixer): Promise<ResponseMixer> => {
    const reqId = this.gen_req_id();
    const res = await this.request({ reqId, features: { mixer: req } });
    if (res.features?.mixer) {
      return res.features.mixer;
    } else {
      throw Error('INVALID_SERVER_RESPONSE');
    }
  };

  public request = async (request: ProtoRequest): Promise<ProtoResponse> => {
    const seq = this.gen_seq_id();
    const buf = ClientEvent.encode({
      seq,
      request,
    }).finish();
    console.log('[Datachannel] send request', seq, request);
    this.dc.send(buf);
    const reqId = request.reqId;
    const res = await new Promise<ProtoResponse>((resolve, reject) => {
      this.reqs.set(reqId, resolve);
      setTimeout(() => {
        if (this.reqs.has(reqId)) {
          this.reqs.delete(reqId);
          reject(new Error('TIMEOUT'));
        }
      }, 5000);
    });

    if (res.error) {
      throw res.error;
    } else {
      return res;
    }
  };

  public gen_req_id = (): number => {
    this.req_id += 1;
    return this.req_id;
  };

  public gen_seq_id = (): number => {
    this.seq_id += 1;
    return this.seq_id;
  };
}

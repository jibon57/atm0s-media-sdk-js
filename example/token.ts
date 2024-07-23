'use server';

export const getToken = async (
  gatewayUrl: string,
  secret: string,
  roomId: string,
  peerId: string,
  record: boolean = false,
  ttl: number = 7200,
) => {
  const url = gatewayUrl + '/token/webrtc';
  const rawResponse = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + secret,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      room: roomId,
      peer: peerId,
      record: record,
      ttl: ttl,
    }),
    cache: 'no-cache',
  });

  if (rawResponse.status == 200) {
    const content = await rawResponse.json();
    if (content.data?.token) {
      return content.data.token;
    } else {
      console.log('create token error', content);
      throw new Error(content.error_code);
    }
  } else {
    const content = await rawResponse.text();
    console.log('create token error', rawResponse.status, content);
    throw new Error(rawResponse.statusText);
  }
};

// Stand-in for the game's HTTP server (it was shut down long ago).

export class Net {
  request(url, method) {
    console.info('[net]', method, url);
    return { code: 404, body: null };
  }
}

'use strict';
class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
const fail = (status, message, code) => new HttpError(status, message, code);
module.exports = { HttpError, fail };

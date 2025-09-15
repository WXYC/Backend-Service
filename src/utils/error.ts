export default class WxycError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number = 500, name: string = 'ClientError') {
    super(message);
    this.name = name;
    this.statusCode = statusCode;
  }
}

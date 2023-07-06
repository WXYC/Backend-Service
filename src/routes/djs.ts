import { Router, Request, Response } from 'express';
import { insertNewDJ } from '../helpers';
import { NewDJ, DJ } from '../db/schema';

export const router = Router();

router.post('/register_dj', async (req: Request, res: Response) => {
  console.log('registering new user');
  console.log(req.body);
  if (!(req.body.real_name && req.body.dj_name && req.body.email)) {
    res.status(400);
    res.send('Bad Request: Missing New DJ Parameters');
  } else {
    const new_dj: NewDJ = {
      real_name: req.body.real_name,
      dj_name: req.body.dj_name,
      email: req.body.email,
    };

    try {
      const dj_obj = await insertNewDJ(new_dj);
      res.status(200);
      res.json(dj_obj);
    } catch (e) {
      console.error(`Failed To Create DJ`);
      console.error(`Error: ${e}`);
      res.status(500);
      res.send(e);
    }
  }
  console.log('----------------------------');
});

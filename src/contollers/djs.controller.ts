import { RequestHandler } from 'express';
import { insertNewDJ, getDJInfo, DJQueryParams } from '../services/djs_service';
import { DJ, NewDJ, djs } from '../db/schema';

export const register: RequestHandler = async (req, res, next) => {
  console.log('registering new user');
  console.log(req.body);
  if (!(req.body.real_name && req.body.dj_name && req.body.email)) {
    console.log('Bad Request: Missing New DJ Parameters');
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
      next(e);
      //   res.status(500);
      //   res.send('Failed to create DJ');
    }
  }
  console.log('----------------------------');
};

export const info: RequestHandler = async (req, res, next) => {
  const query = req.query as unknown as DJQueryParams;
  console.log(query);
  try {
    const dj_info: DJ[] = await getDJInfo(query);

    console.log(dj_info[0]);
    res.status(200);
    res.send(dj_info);
  } catch (e) {
    console.error('Error, looking up DJ');
    console.error(`Error: ${e}`);
    next(e);
  }

  //   try {
  //    // getDJInfo()
  //     // const dj_info: DJ[] = await db
  //     //   .select()
  //     //   .from(djs)
  //     //   .where(sql`lower(${djs.dj_name}) = lower(${req.params.dj_name})`);
  //     // if (dj_info.length) {
  //     //   console.log(dj_info);
  //     //   res.status(200);
  //     //   res.json(dj_info);
  //     // } else {
  //     //   console.log('DJ not found');
  //     //   res.status(404);
  //     //   res.send('DJ not found');
  //     // }
  //   } catch (e) {
  //     console.error('Failed to fetch DJ info');
  //     console.error(e);
  //     res.status(500);
  //     res.send('Failed to fetch DJ info');
  //   }
};

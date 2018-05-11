'use strict'

const fs = require('fs');
const path = require('path');
const command = require('command');
const vec3 = require('vec3');

let me = require('./me');
let cfg = require('./config');

module.exports = function TeraPlayer(dispatch) 
{
  const cmd = command(dispatch);

  let State = null;
  let Recording = false;
  let Playing = false;
  let PlaybackSpeed = 1.0;
  let PlaybackStarted = 0;
  let Ticks = 0;
  let LastEvent = 0;
  let WaitingStarted = 0;

  const ST_REC = 'recording';
  const ST_PLAY = 'playing';
  const ST_STOP = 'stopping';
  const ST_PAUSE = 'paused';
  const ST_LOAD = 'loading';
  const ST_WAIT_USER = 'waiting user';
  const ST_WAIT_CLIENT = 'waiting client';

  const BASIC_REC_HOOKS =  [['S_BOSS_GAGE_INFO', 3],
                            ['S_CREATURE_CHANGE_HP', 6],
                            ['S_CREATURE_ROTATE', 2],
                            ['S_CREATURE_LIFE', 2],
                            ['S_ITEM_EXPLOSION_RESULT', 1],
                            ['S_ABNORMALITY_BEGIN', 2],
                            ['S_ABNORMALITY_END', 1],
                            ['S_ABNORMALITY_FAIL', 1],
                            ['S_ABNORMALITY_REFRESH', 1],
                            ['S_ABNORMALITY_RESIST', 1],
                            ['S_SYSTEM_MESSAGE', 1],
                            ['S_SPAWN_PROJECTILE', 3],
                            ['S_DESPAWN_PROJECTILE', 2],
                            ['S_START_USER_PROJECTILE', 5],
                            ['S_END_USER_PROJECTILE', 3],
                            ['S_CREST_MESSAGE', 3],
                            ['S_USER_MOVETYPE', 1],
                            ['S_USER_LOCATION_IN_ACTION', 2],
                            ['S_USER_FLYING_LOCATION', 2],
                            ['S_USER_STATUS', 1],
                            ['S_ACTION_STAGE', 1],
                            ['S_ACTION_END', 1],
                            ['S_USER_SITUATION', 1],
                            ['S_USER_WEAPON_APPEARANCE_CHANGE', 1],
                            ['S_USER_EFFECT', 1],
                            ['S_USER_APPEARANCE_CHANGE', 1],
                            ['C_PLAYER_FLYING_LOCATION', 4]];

  const LOCK_SKILL_HOOKS = [['C_START_SKILL', 2],
                            ['C_START_INSTANCE_SKILL', 3],
                            ['C_START_INSTANCE_SKILL_EX', 3],
                            ['C_START_TARGETED_SKILL', 4],
                            ['C_START_COMBO_INSTANT_SKILL', 2],
                            ['C_PRESS_SKILL', 2],
                            ['C_NOTIMELINE_SKILL', 1]];

  cmd.add('vhs', (arg1, arg2, arg3) =>
  {
    if (arg1 == 'rec')
    {
      //////////////////
      // REC
      //////////////////
      if (Recording)
      {
        cmd.message('Already recording!');
        return;
      }
      StartRecording();
    }
    else if (arg1 == 'play')
    {
      //////////////////
      // PLAY
      //////////////////
      if (arg2 !== void 0)
      {
        if (Recording)
        {
          cmd.message('Can\'t play while recording!');
          return;
        }
        else if (State)
        {
          cmd.message(`Can\'t play in state '${State}'!`);
          return;
        }
        LoadTape(arg2);
      }
      else
      {
        if (State == ST_PAUSE || State == ST_WAIT_USER)
        {
          cmd.message(`Resuming...`);
          PlaybackStarted += Date.now() - WaitingStarted;
          WaitingStarted = 0;
          State = ST_PLAY;
          Tick();
          return;
        }
        cmd.message('Error. Specify name e.g. \'player play MyCoolRecord\'');
      }
    }
    else if (arg1 == 'stop')
    {
      //////////////////
      // STOP
      //////////////////
      if (Recording)
      {
        StopRecording();
      }
      else if (Playing)
      {
        StopPlaying();
      }
      else
      {
        cmd.message('Nothing to stop!');
      }
    }
    else if (arg1 == 'pause')
    {
      //////////////////
      // PAUSE
      //////////////////
      Pause();
    }
    else if (arg1 == 'save')
    {
      //////////////////
      // SAVE
      //////////////////
      if (arg2 !== void 0)
      {
        SaveTape(arg2);
      }
      else
      {
        cmd.message('Error. Specify name e.g. \'player save MyCoolRecord\'');
      }
    }
    else if (arg1 == 'clear')
    {
      //////////////////
      // CLEAR
      //////////////////
      if (!State)
      {
        ClearCache();
        cmd.message('Cache cleared.');
      }
      else
      {
        cmd.message('Can\'t clear cache atm.');
      }
    }
    else if (arg1 == 'speed' && arg2 !== void 0)
    {
      //////////////////
      // SPEED
      //////////////////
      PlaybackSpeed = Math.min(Math.max(parseFloat(arg2), .25), 2.5);
      cmd.message(`Playback speed has been set to ${PlaybackSpeed}`);
    }
    else
    {
      //////////////////
      // INFO
      //////////////////
      cmd.message('VHS commands:');
      cmd.message('  play MyRecord - plays a record with name MyRecord');
      cmd.message('  play - resumes play after pause');
      cmd.message('  pause - pauses current tape');
      cmd.message('  stop - stops current tape');
      cmd.message('  rec - starts a new tape recording');
      cmd.message('  save MyRecord - saves recorded tape with name MyRecord');
      cmd.message('  speed 1.0 - sets playback speed(min: 0.25, max: 2.5)');
      cmd.message('  clear - purge world cache');
    }
  });

  function GetTapePath(name)
  {
    return cfg.tapeStorage + name + ".tape";
  }

  for (let packet of BASIC_REC_HOOKS)
  {
    try ()
    {
      dispatch.hook(...packet, BasicRecordHook.bind(null, ...packet));
    }
    catch(e)
    {
      console.log(`Failed to bind ${packet[0]}`);
    }
  }

  for (let packet of LOCK_SKILL_HOOKS)
  {
    try ()
    {
      dispatch.hook(...packet, LockSkillHook.bind(null, ...packet));
    }
    catch(e)
    {
      console.log(`Failed to bind ${packet[0]}`);
    }
  }

  function BasicRecordHook()
  {
    if (me.locked) return false;
    if (Recording) RecordEvent(opcode, version, event);
    return true;
  }

  function LockSkillHook()
  {
    if (me.locked)
    {
      SendCantStartSkill(event.skill);
      return false;
    } 
  }

  function StartRecording()
  {
    me.tape.start = Date.now();
    me.tape.id = me.id;
    me.tape.version = cfg.version;
    me.tape.protocol = dispatch.base.protocolVersion;
    me.tape.world = me.world;
    me.tape.startPos = me.pos;
    me.tape.startAngle = me.angle;
    me.tape.login = me.login;
    State = ST_REC;
    Recording = true;
    cmd.message('Recording...');
  }

  function StopRecording()
  {
    State = null;
    Recording = false;
    cmd.message('Stopped recording. Use save command to save the tape.');
  }

  function StartPlaying()
  {
    PlaybackStarted = Date.now();
    State = ST_PLAY;
    cmd.message('Playing...');
    Tick();
  }

  function StopPlaying()
  {
    State = ST_STOP;
    cmd.message(`Stopped you will return back in ${cfg.exitDelay / 1000} seconds`);
    setTimeout(ReturnClientToWorld, cfg.exitDelay);
  }

  function ClientLoaded()
  {
    if (State == ST_STOP)
    {
      RestoreClientWorld();
      me.locked = false;
      State = null;
      return false;
    }
    else if (State == ST_LOAD)
    {
      for (let i = 0; i < me.tape.world.npcs.length; ++i)
      {
        dispatch.toClient('S_SPAWN_NPC', 7, me.tape.world.npcs[i]);
      }
      for (let i = 0; i < me.tape.world.pcs.length; ++i)
      {
        dispatch.toClient('S_SPAWN_USER', 13, me.tape.world.pcs[i]);
      }
      for (let i = 0; i < me.tape.world.wobjs.length; ++i)
      {
        dispatch.toClient('S_SPAWN_WORKOBJECT', 3, me.tape.world.wobjs[i]);
      }
      for (let i = 0; i < me.tape.world.colls.length; ++i)
      {
        dispatch.toClient('S_SPAWN_COLLECTION', 4, me.tape.world.colls[i]);
      }

      if (me.tape.world.aero)
      {
        dispatch.toClient('S_AERO', 1, me.tape.world.aero);
      }

      dispatch.toClient('S_SPAWN_ME', 2, 
      {
        gameId : me.gameId,
        loc : me.tape.startPos,
        w : me.tape.startAngle,
        alive : true
      });

      let fakeStats = me.stats;
      fakeStats.runSpeed = 160;
      fakeStats.runSpeedBonus = 300;
      dispatch.toClient('S_PLAYER_STAT_UPDATE', 9, fakeStats);

      cmd.message(`Play will start in ${cfg.startDelay / 1000} seconds`);
      setTimeout(StartPlaying, cfg.startDelay);
      return false
    }
    else if (State == ST_REC)
    {
      RecordEvent('C_LOAD_TOPO_FIN', 1, event);
    }
    else if (State == ST_WAIT_CLIENT)
    {
      State = ST_PLAY;
      Tick();
    }
    return true;
  }

  function Pause()
  {
    WaitingStarted = Date.now();
    State = ST_PAUSE;
  }

  function LoadTape(name)
  {
    me.locked = true;
    State = ST_LOAD;
    fs.readFile(GetTapePath(name), 'utf8', function readFileCallback(err, data)
    {
      if (err)
      {
        cmd.message(err);
      } 
      else 
      {
        me.tape = JSON.parse(data);
        me.tape.fakeId = {low : 11111111, high : me.id.high};
        setTimeout(OnTapeLoaded, 100);
      }
    });
  }

  function OnTapeLoaded()
  {
    dispatch.toClient('S_LOAD_TOPO', 3, 
    {
      zone: me.tape.startZone,
      loc : me.tape.startPos,
      quick : false
    });
  }

  function SaveTape(name)
  {
    if (!me.tape)
    {
      cmd.message('Nothing to save!');
      return;
    }
    if (!name)
    {
      cmd.message('Can\'t save without name!');
      return;
    }
    var json = JSON.stringify(me.tape);
    let path = GetTapePath(name);
    fs.writeFile(path, json, 'utf8', function writeFileCallback(err)
    {
      if (err)
      {
        cmd.message(err);
      }
      else
      {
        cmd.message(`Saved to ${path}`);
        setTimeout(OnTapeSaved, 100);
      }
    });
  }

  function OnTapeSaved()
  {
    me.tape.data = [];
    me.tape.world = null;
    me.tape.login = null;
    me.tape.startPos = null;
  }

  function ReturnClientToWorld()
  {
    dispatch.toClient('S_LOAD_TOPO', 3, 
    {
      zone: me.zone,
      loc : me.pos,
      quick : false
    });
  }

  function RecordEvent(name, version, event)
  {
    me.tape.data.push({time : Date.now() - me.tape.start, opcode : name, revision : version, packet : event});
  }

  function RestoreClientWorld()
  {
    for (let i = 0; i < me.world.npcs.length; i++) 
    {
      dispatch.toClient('S_SPAWN_NPC', 7, me.world.npcs[i]);
    }
    for (let i = 0; i < me.world.pcs.length; i++) 
    {
      dispatch.toClient('S_SPAWN_USER', 13, me.world.npcs[i]);
    }
    for (let i = 0; i < me.world.wobjs.length; i++) 
    {
      dispatch.toClient('S_SPAWN_WORKOBJECT', 3, me.world.wobjs[i]);
    }
    for (let i = 0; i < me.world.colls.length; i++) 
    {
      dispatch.toClient('S_SPAWN_COLLECTION', 4, me.world.colls[i]);
    }
    if (me.world.aero)
    {
      dispatch.toClient('S_AERO', 1, me.world.aero);
    }
    dispatch.toClient('S_PLAYER_STAT_UPDATE', 9, me.stats);
  }

  function ClearCache()
  {
    me.world.npcs = [];
    me.world.pcs = [];
    me.world.wobjs = [];
    me.world.colls = [];
    me.world.aero = null;
  }

  function Tick()
  {
    if (State == ST_PLAY)
    {
      let tickDelay = 1000 / cfg.ticksPerSecond;
      let currentTickTime = Ticks * tickDelay;

      let events = [];
      let cnt = me.tape.data.length;
      let loadTopo = false;
      // Get all events for the current frame
      for (; LastEvent < cnt; ++LastEvent)
      {
        if (me.tape.data[LastEvent].time > currentTickTime + tickDelay + cfg.tapeOverhead)
        {
          break;
        }
        events.push(me.tape.data[LastEvent]);
      }

      // Send to client
      cnt = events.length;
      loadTopo = false;
      for (let i = 0; i < cnt; ++i)
      {
        if (events[i].opcode == 'S_LOAD_TOPO')
        {
          if (!cfg.autoTeleport)
          {
            Ticks++;
            State = ST_WAIT_USER;
            WaitingStarted = Date.now();
            LastEvent -= cnt - i; // We won't execute next events so fix LastEvent to process them later
            cmd.message('You reached the end of this location. Use command \'continue\' to resume playing.');
            break;
          }
          else
          {
            loadTopo = true; // Execute all next frames asap in one shot
          }
        }
        else if (event[i].opcode == 'C_LOAD_TOPO_FIN')
        {
          Ticks++;
          State = ST_WAIT_USER;
          WaitingStarted = Date.now();
          LastEvent -= cnt - i - 1; // We won't execute next events now so fix LastEvent to process them later. And skip C_LOAD_TOPO_FIN.
          break;
        }
        ExecuteFrame(events[i], loadTopo ? event.time : currentTickTime); // if loadTopo is set - we need to execute frames asap. So ignore event.time
      }

      let tickLag = Date.now() - PlaybackStarted - currentTickTime;
      tickDelay /= PlaybackSpeed;

      // Schedule next frame
      if (LastEvent < me.tape.data.length)
      {
        Ticks++;
        setTimeout(Tick, tickDelay);
      }
      else
      {
        cmd.message('Reached the end of tape!');
      }
    }
  }

  function ExecuteFrame(event, tickTime)
  {
    if (event.opcode == 'S_SPAWN_ME')
    {
      event.gameId = me.id;
      event.alive = true;

      if (cfg.showMe)
      {
        dispatch.toClient('S_SPAWN_USER', 13,
        {
          serverId : me.tape.login.serverId,
          playerId : me.tape.login.playerId, // should fake?
          gameId : me.tape.fakeId,
          loc : event.loc,
          w : event.w,
          templateId : me.tape.login.templateId,
          visible : true,
          alive : event.alive,
          appearance : me.tape.login.appearance,
          weapon : me.tape.login.weapon,
          body : me.tape.login.body,
          hand : me.tape.login.hand,
          feet : me.tape.login.feet,
          underware : me.tape.login.underware,
          head : me.tape.login.head,
          face : me.tape.login.face,
          spawnFx : 1,
          mount : 0, //fixme
          pose : 0,
          title : title,
          gm : cfg.gm,
          weaponModel : me.tape.login.weaponModel,
          bodyModel : me.tape.login.bodyModel,
          handModel : me.tape.login.handModel,
          feetModel : me.tape.login.feetModel,
          bodyDye : me.tape.login.bodyDye,
          handDye : me.tape.login.handDye,
          feetDye : me.tape.login.feetDye,
          weaponEnchant : me.tape.login.weaponEnchant,
          newbie : me.tape.login.newbie,
          pkEnabled : me.tape.login.infamy, // fixme ??
          level : me.tape.login.level,
          vehicleEx : 0, // fixme
          showFace : me.tape.login.showFace,
          styleHead : me.tape.login.styleHead,
          styleFace : me.tape.login.styleFace,
          styleBack : me.tape.login.styleBack,
          styleWeapon : me.tape.login.styleWeapon,
          styleBody : me.tape.login.styleBody,
          styleFootprint : me.tape.login.styleFootprint,
          showStyle : me.tape.login.showStyle,
          appearance2 : me.tape.login.appearance2,
          scale : me.tape.login.scale
          name : me.tape.login.name,
          details : me.tape.login.details,
          shape : shape
        });
      }
      setTimeout(function(){dispatch.toClient(event.opcode, event.revision, event.packet);}, (event.time - tickTime) / PlaybackSpeed);
    }
    else if (event.opcode == 'C_PLAYER_LOCATION')
    {
      if (cfg.showMe)
      {
        dispatch.toClient('S_USER_LOCATION', 4,
        {
          gameId : me.tape.fakeId,
          loc : event.loc,
          w : event.w,
          LookDirection : event.lookDirection,
          speed : me.tape.stats.runSpeed + me.tape.stats.runSpeedBonus, // Fixme
          dest : event.dest,
          type : event.type,
          inShuttle : false,
          time : Date.now()
        });
      }
    }
    else if (event.opcode.startsWith('C_'))
    {
      // Ignore all client packets
      return;
    }
    else
    {
      if (event.gameId && event.gameId.equals(me.tape.id))
      {
        if (!cfg.showMe) return;
        event.gameId = me.tape.fakeId;
      }
      if (event.target && event.target.equals(me.tape.id))
      {
        if (!cfg.showMe) return;
        event.target = me.tape.fakeId;
      }
      if (event.source && event.source.equals(me.tape.id))
      {
        if (!cfg.showMe) return;
        event.source = me.tape.fakeId;
      }

      if (event.speed)
      {
        event.speed /= PlaybackSpeed;
      }
      if (event.duration)
      {
        event.duration /= PlaybackSpeed;
      }
      if (event.movement)
      {
        for (let i = 0; i < event.movement.length; ++i)
        {
          event.movement[i].duration /= PlaybackSpeed;
          event.movement[i].speed /= PlaybackSpeed;
        }
      }
      setTimeout(function(){dispatch.toClient(event.opcode, event.revision, event.packet);}, (event.time - tickTime) / PlaybackSpeed);
    }
  }

  dispatch.hook('S_LOGIN', 10, (event) =>
  {
    me.id = event.gameId;
    me.login = event;
  });

  dispatch.hook('S_LOAD_TOPO', 3, (event) => 
  {
    if (!State)
    {
      ClearCache();
    }
    else if (State == ST_PLAY)
    {
      me.pos = event.loc;
      me.zone = event.zone;
      // While any tape is beeing played and server requestes to load topo we should simulate it
      // We also should clear cache to remove stuff from a previous location
      setTimeout(function () {ClearCache(); dispatch.toServer('C_LOAD_TOPO_FIN', 1, {});}, 5000);
    }
    if (Recording)
    {
      RecordEvent('S_LOAD_TOPO', 3, event);
    }
  });

  dispatch.hook('C_LOAD_TOPO_FIN', (event) => 
  {
    return ClientLoaded();
  });

  function SendCantStartSkill(skillId)
  {
    dispatch.toClient('S_CANNOT_START_SKILL', 1, 
    {
        skill : skillId
    });
  }

  dispatch.hook('C_CANCEL_SKILL', (event) => 
  {
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('C_USE_ITEM', (event) => 
  {
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('C_ASK_INTERACTIVE', (event) => 
  {
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('S_EACH_SKILL_RESULT', (event) => 
  {
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('C_HIT_USER_PROJECTILE', (event) => 
  {
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('C_CAN_LOCKON_TARGET', (event) => 
  {
    if (me.locked)
    {
      dispatch.toClient('S_CAN_LOCKON_TARGET', 1,
      {
        target : event.target,
        unk : event.unk,
        skill : event.skill,
        ok : false
      });
      return false;
    }
  });

  dispatch.hook('C_PLAYER_LOCATION', 5, (event) => 
  {
    me.pos = event.loc.addN(event.dest).scale(0.5);
    me.angle = event.w;
    return BasicRecordHook('C_PLAYER_LOCATION', 5, event);
  });

  dispatch.hook('S_PLAYER_STAT_UPDATE', 9, (event) => 
  {
    me.stats = event;
    return BasicRecordHook('S_PLAYER_STAT_UPDATE', 9, event);
  });

  dispatch.hook('S_PARTY_MEMBER_LIST', 1, (event) => 
  {
    me.party = event;
    return BasicRecordHook('S_PARTY_MEMBER_LIST', 1, event);
  });

  dispatch.hook('S_SPAWN_ME', 2, (event) => 
  {
    me.pos = event.loc;
    return BasicRecordHook('S_SPAWN_ME', 2, event);
  });

  dispatch.hook('S_USER_EXTERNAL_CHANGE', 6, (event) => 
  {
    for (let i = 0; i < me.world.pcs.length; ++i) 
    {
      if (me.world.pcs[i].gameId.equals(event.gameId))
      {
        me.world.pcs[i].weapon = event.weapon;
        me.world.pcs[i].body = event.body;
        me.world.pcs[i].hand = event.hand;
        me.world.pcs[i].feet = event.feet;
        me.world.pcs[i].appearance = event.appearance;
        me.world.pcs[i].weaponModel = event.weaponModel;
        me.world.pcs[i].bodyModel = event.bodyModel;
        me.world.pcs[i].handModel = event.handModel;
        me.world.pcs[i].feetModel = event.feetModel;
        me.world.pcs[i].underware = event.underware;
        me.world.pcs[i].weaponEnchant = event.weaponEnchant;
        me.world.pcs[i].head = event.head;
        me.world.pcs[i].face = event.face;
        me.world.pcs[i].styleHead = event.styleHead;
        me.world.pcs[i].styleFace = event.styleFace;
        me.world.pcs[i].styleBack = event.styleBack;
        me.world.pcs[i].styleWeapon = event.styleWeapon;
        me.world.pcs[i].styleBody = event.styleBody;
        me.world.pcs[i].styleFootprint = event.styleFootprint;
        me.world.pcs[i].bodyDye = event.bodyDye;
        me.world.pcs[i].handDye = event.handDye;
        me.world.pcs[i].feetDye = event.feetDye;
        me.world.pcs[i].showStyle = event.showStyle;
        break;
      }
    }

    return BasicRecordHook('S_USER_EXTERNAL_CHANGE', 6, event);
  });

  dispatch.hook('S_NPC_LOCATION', 3, (event) => 
  {
    for (let i = 0; i < me.world.npcs.length; ++i) 
    {
      if (me.world.npcs[i].gameId.equals(event.gameId))
      {
        me.world.npcs[i].loc = event.dest;
        break;
      }
    }
    return BasicRecordHook('S_NPC_LOCATION', 3, event);
  });

  dispatch.hook('S_SPAWN_NPC', 7, (event) =>
  {
    me.world.npcs.push(event);
    return BasicRecordHook('S_SPAWN_NPC', 7, event);
  });

  dispatch.hook('S_DESPAWN_NPC', 3, (event) =>
  {
    for (let i = 0; i < me.world.npcs.length; ++i) 
    {
      if (me.world.npcs[i].gameId.equals(event.gameId))
      {
        me.world.npcs.splice(i, 1);
        break;
      }
    }
    return BasicRecordHook('S_DESPAWN_NPC', 3, event);
  });

  dispatch.hook('S_SPAWN_COLLECTION', 4, (event) =>
  {
    me.world.colls.push(event);
    return BasicRecordHook('S_SPAWN_COLLECTION', 4, event);
  });

  dispatch.hook('S_DESPAWN_COLLECTION', 2, (event) =>
  {
    for (let i = 0; i < me.world.colls.length; ++i) 
    {
      if (me.world.colls[i].gameId.equals(event.gameId))
      {
        me.world.colls.splice(i, 1);
        break;
      }
    }
    return BasicRecordHook('S_DESPAWN_COLLECTION', 2, event);
  });

  dispatch.hook('S_SPAWN_USER', 13, (event) =>
  {
    me.world.pcs.push(event);
    return BasicRecordHook('S_SPAWN_USER', 13, event);
  });

  dispatch.hook('S_DESPAWN_USER', 3, (event) =>
  {
    for (let i = 0; i < me.world.pcs.length; ++i) 
    {
      if (me.world.pcs[i].gameId.equals(event.gameId))
      {
        me.world.pcs.splice(i, 1);
        break;
      }
    }
    return BasicRecordHook('S_DESPAWN_USER', 3, event);
  });

  dispatch.hook('S_SPAWN_WORKOBJECT', 3, (event) =>
  {
    me.world.wobjs.push(event);
    return BasicRecordHook('S_SPAWN_WORKOBJECT', 3, event);
  });

  dispatch.hook('S_DESPAWN_WORKOBJECT', 2, (event) =>
  {
    for (let i = 0; i < me.world.wobjs.length; ++i) 
    {
      if (me.world.wobjs[i].gameId.equals(event.gameId))
      {
        me.world.wobjs.splice(i, 1);
        break;
      }
    }
    return BasicRecordHook('S_DESPAWN_WORKOBJECT', 2, event);
  });

  dispatch.hook('S_USER_LOCATION', 4, (event) =>
  {
    for (let i = 0; i < me.world.pcs.length; ++i) 
    {
      if (me.world.pcs[i].gameId.equals(event.gameId))
      {
        me.world.pcs[i].loc = event.dest;
        me.world.pcs[i].w = event.w;
        break;
      }
    }
    return BasicRecordHook('S_USER_LOCATION', 4, event);
  });

  dispatch.hook('S_LEAVE_PARTY', 3, (event) =>
  {
    me.party = null;
    return BasicRecordHook('S_LEAVE_PARTY', 3, event);
  });

  dispatch.hook('S_INSTANT_MOVE', 3, (event) =>
  {
    let found = false;
    for (let i = 0; i < me.world.pcs.length; ++i) 
    {
      if (me.world.pcs[i].gameId.equals(event.gameId))
      {
        me.world.pcs[i].loc = event.loc;
        me.world.pcs[i].w = event.w;
        found = true;
        break;
      }
    }
    if (!found)
    {
      for (let i = 0; i < me.world.npcs.length; ++i) 
      {
        if (me.world.npcs[i].gameId.equals(event.gameId))
        {
          me.world.npcs[i].loc = event.loc;
          me.world.npcs[i].w = event.w;
          break;
        }
      }
    }
    return BasicRecordHook('S_INSTANT_MOVE', 3, event);
  });

  dispatch.hook('S_INSTANT_DASH', 3, (event) =>
  {
    let found = false;
    for (let i = 0; i < me.world.pcs.length; ++i) 
    {
      if (me.world.pcs[i].gameId.equals(event.gameId))
      {
        me.world.pcs[i].loc = event.loc;
        me.world.pcs[i].w = event.w;
        found = true;
        break;
      }
    }
    if (!found)
    {
      for (let i = 0; i < me.world.npcs.length; ++i) 
      {
        if (me.world.npcs[i].gameId.equals(event.gameId))
        {
          me.world.npcs[i].loc = event.loc;
          me.world.npcs[i].w = event.w;
          break;
        }
      }
    }
    return BasicRecordHook('S_INSTANT_DASH', 3, event);
  });

  dispatch.hook('S_AERO', 1, (event) => 
  {
    me.world.aero = event;
    return BasicRecordHook('S_AERO', 1, event);
  });

  dispatch.hook('S_MOUNT_VEHICLE', 2, (event) => 
  {
    return BasicRecordHook('S_MOUNT_VEHICLE', 2, event);
  });

  dispatch.hook('S_UNMOUNT_VEHICLE', 2, (event) => 
  {
    return BasicRecordHook('S_UNMOUNT_VEHICLE', 2, event);
  });

  dispatch.hook('S_MOUNT_VEHICLE_EX', 1, (event) => 
  {
    for (let i = 0; i < me.world.pcs.length; ++i) 
    {
      if (me.world.pcs[i].gameId.equals(event.gameId))
      {
        me.world.pcs[i].vehicleEx = event.vehicle;
        break;
      }
    }
    return return BasicRecordHook('S_MOUNT_VEHICLE_EX', 1, event);
  });

  dispatch.hook('S_UNMOUNT_VEHICLE_EX', 1, (event) => 
  {
    for (let i = 0; i < me.world.pcs.length; ++i) 
    {
      if (me.world.pcs[i].gameId.equals(event.gameId))
      {
        me.world.pcs[i].vehicleEx = 0;
        break;
      }
    }
    return BasicRecordHook('S_UNMOUNT_VEHICLE_EX', 1, event);
  });

  dispatch.hook('S_INVEN', 'raw', (event) =>
  {
    if (me.locked)
    {
      return false;
    }
  });
}
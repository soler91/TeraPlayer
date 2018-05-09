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

  const ST_REC = 'recording';
  const ST_PLAY = 'playing';
  const ST_STOP = 'stopping';
  const ST_PAUSE = 'paused';
  const ST_LOAD = 'loading';
/*
 rec %name% - start recording
 play %name% - start playing
 play - resume paused play
 pause - pause a play
 clear - clear world cache
 stop - stop recording or playing
 save - save recording
*/
  cmd.add('player', (arg1, arg2, arg3) =>
  {
    if (arg1 == 'rec')
    {
      //////////////////
      // Record
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
        if (State == ST_PAUSE)
        {
          cmd.message(`Resuming`);
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
      cmd.message('Supported commands:');
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
  function StartRecording()
  {
    me.tape.start = Date.now();
    me.tape.id = me.id;
    me.tape.version = cfg.version;
    me.tape.protocol = dispatch.base.protocolVersion;
    me.tape.world = me.world;
    me.tape.startPos = me.pos;
    me.tape.startAngle = me.angle;
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
    return true;
  }

  function Pause()
  {
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
  }

  function Tick()
  {
    if (State == ST_PLAY)
    {
      let tickDelay = 1000 / cfg.ticksPerSecond;
      let currentTickTime = Ticks * tickDelay;

      let events = [];
      let cnt = me.tape.data.length;
      // Get all events for the current frame
      for (; LastEvent < cnt; ++LastEvent)
      {
        if (me.tape.data[LastEvent].time > currentTickTime + tickDelay + cfg.tapeOverhead)
        {
          break;
        }
        events.push(me.tape.data[LastEvent]);
      }

      // Dispatch to client
      cnt = events.length;
      for (let i = 0; i < cnt; ++i)
      {
        ProcessFrame(events[i], currentTickTime);
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
        cmd.message('Riched the end of tape!');
      }
    }
  }

  function ProcessFrame(event, tickTime)
  {
    setTimeout(function(){dispatch.toClient(event.name, event.revision, event.packet);}, (event.time - tickTime) / PlaybackSpeed);
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

  dispatch.hook('C_PLAYER_FLYING_LOCATION', 4, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('C_START_SKILL', 2, (event) => 
  {
    if (me.locked)
    {
      SendCantStartSkill(event.skill);
      return false;
    }
  });
  
  dispatch.hook('C_START_INSTANCE_SKILL', (event) => 
  {
    if (me.locked)
    {
      SendCantStartSkill(event.skill);
      return false;
    }
  });

  dispatch.hook('C_START_INSTANCE_SKILL_EX', (event) => 
  {
    if (me.locked)
    {
      SendCantStartSkill(event.skill);
      return false;
    }
  });

  dispatch.hook('C_START_TARGETED_SKILL', (event) => 
  {
    if (me.locked)
    {
      SendCantStartSkill(event.skill);
      return false;
    }
  });

  dispatch.hook('C_START_COMBO_INSTANT_SKILL', (event) => 
  {
    if (me.locked)
    {
      SendCantStartSkill(event.skill);
      return false;
    }
  });

  dispatch.hook('C_PRESS_SKILL', (event) => 
  {
    if (me.locked)
    {
      SendCantStartSkill(event.skill);
      return false;
    }
  });

  dispatch.hook('C_NOTIMELINE_SKILL', (event) => 
  {
    if (me.locked)
    {
      SendCantStartSkill(event.skill);
      return false;
    }
  });

  dispatch.hook('C_CANCEL_SKILL', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('C_PLAYER_LOCATION', 3, (event) => 
  {
    me.pos = event.loc.addN(event.dest).scale(0.5);
    me.angle = event.w;
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('C_USE_ITEM', 3, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('C_ASK_INTERACTIVE', 2, (event) => 
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

  dispatch.hook('C_HIT_USER_PROJECTILE', (event) => 
  {
    if (me.locked)
    {
      return false;
    }
  });

  dispatch.hook('S_PLAYER_STAT_UPDATE', 9, (event) => 
  {
    me.stats = event;
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_PLAYER_STAT_UPDATE', 9, event);
    }
  });

  dispatch.hook('S_BOSS_GAGE_INFO', 3, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_BOSS_GAGE_INFO', 9, event);
    }
  });

  dispatch.hook('S_PARTY_MEMBER_LIST', 1, (event) => 
  {
    me.party = event;
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_PARTY_MEMBER_LIST', 1, event);
    }
  });

  dispatch.hook('S_CREATURE_CHANGE_HP', 6, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_CREATURE_CHANGE_HP', 6, event);
    }
  });

  dispatch.hook('S_CREATURE_ROTATE', 2, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_CREATURE_ROTATE', 2, event);
    }
  });

  dispatch.hook('S_CREATURE_LIFE', 2, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_CREATURE_LIFE', 2, event);
    }
  });

  dispatch.hook('S_ITEM_EXPLOSION_RESULT', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_ITEM_EXPLOSION_RESULT', 1, event);
    }
  });

  dispatch.hook('S_ABNORMALITY_BEGIN', 2, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_ABNORMALITY_BEGIN', 2, event);
    }
  });

  dispatch.hook('S_ABNORMALITY_END', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_ABNORMALITY_END', 1, event);
    }
  });

  dispatch.hook('S_ABNORMALITY_FAIL', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_ABNORMALITY_FAIL', 1, event);
    }
  });

  dispatch.hook('S_ABNORMALITY_REFRESH', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_ABNORMALITY_REFRESH', 1, event);
    }
  });

  dispatch.hook('S_ABNORMALITY_RESIST', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_ABNORMALITY_RESIST', 1, event);
    }
  });

  dispatch.hook('S_SPAWN_ME', 2, (event) => 
  {
    me.pos = event.loc;
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_SPAWN_ME', 2, event);
    }
  });

  dispatch.hook('S_USER_APPEARANCE_CHANGE', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_APPEARANCE_CHANGE', 1, event);
    }
  });

  dispatch.hook('S_SYSTEM_MESSAGE', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_SYSTEM_MESSAGE', 1, event);
    }
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
        me.world.pcs[i].bodyDie = event.bodyDie;
        me.world.pcs[i].handDie = event.handDie;
        me.world.pcs[i].feetDie = event.feetDie;
        me.world.pcs[i].showStyle = event.showStyle;
        break;
      }
    }
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_EXTERNAL_CHANGE', 6, event);
    }
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
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_NPC_LOCATION', 3, event);
    }
  });

  dispatch.hook('S_SPAWN_NPC', 7, (event) =>
  {
    me.world.npcs.push(event);
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_SPAWN_NPC', 7, event);
    }
  });

  dispatch.hook('S_SPAWN_PROJECTILE', 3, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_SPAWN_PROJECTILE', 3, event);
    }
  });

  dispatch.hook('S_DESPAWN_PROJECTILE', 2, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_DESPAWN_PROJECTILE', 2, event);
    }
  });

  dispatch.hook('S_START_USER_PROJECTILE', 5, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_START_USER_PROJECTILE', 5, event);
    }
  });

  dispatch.hook('S_END_USER_PROJECTILE', 3, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_END_USER_PROJECTILE', 3, event);
    }
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

    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_DESPAWN_NPC', 3, event);
    }
  });

  dispatch.hook('S_SPAWN_COLLECTION', 4, (event) =>
  {
    me.world.colls.push(event);
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_SPAWN_COLLECTION', 4, event);
    }
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

    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_DESPAWN_COLLECTION', 2, event);
    }
  });

  dispatch.hook('S_SPAWN_USER', 13, (event) =>
  {
    me.world.pcs.push(event);
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_SPAWN_USER', 13, event);
    }
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

    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_DESPAWN_USER', 3, event);
    }
  });

  dispatch.hook('S_SPAWN_WORKOBJECT', 3, (event) =>
  {
    me.world.wobjs.push(event);
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_SPAWN_WORKOBJECT', 3, event);
    }
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

    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_DESPAWN_WORKOBJECT', 3, event);
    }
  });

  dispatch.hook('S_CREST_MESSAGE', (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_CREST_MESSAGE', 3, event);
    }
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
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_LOCATION', 4, event);
    }
  });

  dispatch.hook('S_USER_MOVETYPE', 1, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_MOVETYPE', 1, event);
    }
  });

  dispatch.hook('S_LEAVE_PARTY', 3, (event) =>
  {
    me.party = null;
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_LEAVE_PARTY', 3, event);
    }
  });

  dispatch.hook('S_USER_LOCATION_IN_ACTION', 2, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_LOCATION_IN_ACTION', 2, event);
    }
  });

  dispatch.hook('S_USER_FLYING_LOCATION', 2, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_FLYING_LOCATION', 2, event);
    }
  });

  dispatch.hook('S_USER_STATUS', 1, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_STATUS', 1, event);
    }
  });

  dispatch.hook('S_USER_SITUATION', 1, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_SITUATION', 1, event);
    }
  });

  dispatch.hook('S_USER_WEAPON_APPEARANCE_CHANGE', 1, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_WEAPON_APPEARANCE_CHANGE', 1, event);
    }
  });

  dispatch.hook('S_USER_EFFECT', 1, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_USER_EFFECT', 1, event);
    }
  });

  dispatch.hook('S_UNEQUIP_ITEM', 2, (event) =>
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_UNEQUIP_ITEM', 2, event);
    }
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
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_INSTANT_MOVE', 3, event);
    }
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
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_INSTANT_DASH', 3, event);
    }
  });

  dispatch.hook('S_ACTION_STAGE', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_ACTION_STAGE', 1, event);
    }
  });

  dispatch.hook('S_ACTION_END', 1, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_ACTION_END', 1, event);
    }
  });

  dispatch.hook('S_AERO', 1, (event) => 
  {
    me.world.aero = event;
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_AERO', 1, event);
    }
  });

  dispatch.hook('S_MOUNT_VEHICLE', 2, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_MOUNT_VEHICLE', 2, event);
    }
  });

  dispatch.hook('S_UNMOUNT_VEHICLE', 2, (event) => 
  {
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_UNMOUNT_VEHICLE', 2, event);
    }
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
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_MOUNT_VEHICLE_EX', 1, event);
    }
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
    if (me.locked)
    {
      return false;
    }
    if (Recording)
    {
      RecordEvent('S_UNMOUNT_VEHICLE_EX', 1, event);
    }
  });

  dispatch.hook('S_INVEN', 'raw', (event) =>
  {
    if (me.locked)
    {
      return false;
    }
  });
}